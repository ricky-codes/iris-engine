import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Metrics } from '../src/engine/metrics.js';
import type { ToolDefinition } from '../src/engine/tool.js';
import { EngineError } from '../src/engine/errors.js';
import { diagnosticTool } from '../src/tools/diagnostic.js';
import { fakeAccess, fakeEngine, fakeLlm } from './engine/fakes.js';
import { buildTestApp } from './helpers.js';

const SECRET = 's'.repeat(40);
const AUTH = { authorization: `Bearer ${SECRET}` };
const BODY = { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA', message: 'Olá' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(access = fakeAccess(), llm = fakeLlm('{"reply":"Olá!"}')) {
  app = await buildTestApp({
    engine: {
      engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], {
        access: access.access,
        llm: llm.llm,
      }),
      apiSecret: SECRET,
    },
  });
  return { app, access, llm };
}

describe('POST /v1/tools/:nome', () => {
  it('responde com a ferramenta, a versão e o resultado', async () => {
    const { app } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tool: 'diagnostic', version: 1, result: { reply: 'Olá!' } });
  });

  it.each([
    ['sem cabeçalho', {}],
    ['segredo errado', { authorization: 'Bearer outro' }],
    ['esquema errado', { authorization: `Basic ${SECRET}` }],
  ])('401 com %s, antes de validar o corpo', async (_label, headers) => {
    const { app, access } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(access.calls).toHaveLength(0);
  });

  it('422 com corpo inválido, sem gastar utilização no StepAccess', async () => {
    const { app, access } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, userId: '005curto', extra: 1 },
    });
    expect(res.statusCode).toBe(422);
    const paths = res
      .json<{ error: { details: { path: string }[] } }>()
      .error.details.map((d) => d.path);
    expect(paths).toContain('body.userId');
    expect(access.calls).toHaveLength(0);
  });

  it('aceita a versão certa e recusa outra', async () => {
    const { app } = await start();
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, version: 1 },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, version: 2 },
    });
    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(422);
  });

  it('ferramenta desconhecida: 404 unknown_tool', async () => {
    const { app } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/sentimento',
      headers: AUTH,
      payload: BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'unknown_tool' } });
  });

  it('a recusa do StepAccess passa ao Salesforce com o mesmo código', async () => {
    const denied = new EngineError('quota_exceeded', 'Limite atingido.', [
      { path: 'access', issue: 'LIMIT_REACHED' },
    ]);
    const { app, llm } = await start(fakeAccess(denied));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: BODY,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: { code: 'quota_exceeded', details: [{ issue: 'LIMIT_REACHED' }] },
    });
    expect(llm.requests).toHaveLength(0);
  });

  it('o modelo indisponível dá 502 provider_unavailable', async () => {
    const { app } = await start(
      fakeAccess(),
      fakeLlm(new EngineError('provider_unavailable', 'Indisponível.')),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: BODY,
    });
    expect(res.statusCode).toBe(502);
  });
});

describe('métricas', () => {
  it('conta sucessos e erros por código, com tokens, sem conteúdo', async () => {
    const metrics = new Metrics();
    const denied = fakeAccess(new EngineError('quota_exceeded', 'Limite.'));
    const llm = fakeLlm('{"reply":"ok"}');
    app = await buildTestApp({
      engine: {
        engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], { llm: llm.llm }),
        apiSecret: SECRET,
        metrics,
      },
    });
    const post = (headers: Record<string, string>, payload: object) =>
      app?.inject({ method: 'POST', url: '/v1/tools/diagnostic', headers, payload });
    await post(AUTH, BODY);
    await post({}, BODY);
    await post(AUTH, { ...BODY, message: '' });
    await app.close();

    app = await buildTestApp({
      engine: {
        engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], {
          access: denied.access,
          llm: llm.llm,
        }),
        apiSecret: SECRET,
        metrics,
      },
    });
    await post(AUTH, BODY);

    const s = metrics.snapshot();
    expect(s.byTool).toEqual([
      expect.objectContaining({
        tool: 'diagnostic',
        requests: 4,
        succeeded: 1,
        failed: 3,
        errorsByCode: { invalid_request: 1, quota_exceeded: 1, unauthorized: 1 },
        inputTokens: 10,
        outputTokens: 5,
      }),
    ]);
    expect(JSON.stringify(s)).not.toContain('005AAAAAAAAAAAAAAA');
  });
});

describe('GET /v1/tools', () => {
  it('lista as ferramentas, só com credencial', async () => {
    const { app } = await start();
    const anon = await app.inject({ method: 'GET', url: '/v1/tools' });
    expect(anon.statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/v1/tools', headers: AUTH });
    expect(res.json()).toEqual({
      tools: [{ name: 'diagnostic', version: 1, description: diagnosticTool.description }],
    });
  });
});

describe('sem motor', () => {
  it('não há rotas de ferramentas', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
