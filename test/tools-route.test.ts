import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Metrics } from '../src/engine/metrics.js';
import type { ToolDefinition } from '../src/engine/tool.js';
import { EngineError } from '../src/engine/errors.js';
import { diagnosticTool } from '../src/tools/diagnostic.js';
import type { EngineSettings } from '../src/engine/engine.js';
import type { ToolOverrides } from '../src/engine/store.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeStore } from './engine/fakes.js';
import type { Live } from '../src/engine/live.js';
import { buildTestApp } from './helpers.js';

const SECRET = 's'.repeat(40);
const AUTH = { authorization: `Bearer ${SECRET}` };
const BODY = { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA', message: 'Olá' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  access = fakeAccess(),
  llm = fakeLlm('{"reply":"Olá!"}'),
  extra: { settings?: Live<EngineSettings>; overrides?: Partial<ToolOverrides> } = {},
) {
  app = await buildTestApp({
    engine: {
      engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], {
        access: access.access,
        llm: llm.llm,
        ...(extra.settings !== undefined && { settings: extra.settings }),
        ...fakeStore(
          undefined,
          extra.overrides === undefined ? {} : { overrides: extra.overrides },
        ),
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
      tools: [
        {
          name: 'diagnostic',
          version: 1,
          description: diagnosticTool.description,
          streaming: true,
        },
      ],
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

describe('POST /v1/tools/:nome com stream', () => {
  /** Lê o corpo SSE em eventos `{event, data}`. */
  const parseSse = (payload: string) =>
    payload
      .trim()
      .split('\n\n')
      .map((block) => {
        const [e, d] = block.split('\n');
        return { event: e?.slice(7), data: JSON.parse(d?.slice(6) ?? 'null') as unknown };
      });

  it('responde em SSE: start, deltas, result', async () => {
    const { app } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-request-id']).toBeTruthy();
    const events = parseSse(res.payload);
    expect(events[0]?.event).toBe('start');
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text).toBe('Olá!');
    expect(events.at(-1)).toEqual({
      event: 'result',
      data: { tool: 'diagnostic', version: 1, result: { reply: 'Olá!' } },
    });
  });

  it('stream:false é o pedido normal', async () => {
    const { app } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, stream: false },
    });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ result: { reply: 'Olá!' } });
  });

  it('sem acesso, o erro sai como JSON normal (o estado HTTP ainda não seguiu)', async () => {
    const { app } = await start(fakeAccess(new EngineError('access_denied', 'Sem acesso.')));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, stream: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'access_denied' } });
  });

  it('um erro do modelo depois de começar vai num evento error', async () => {
    const { app } = await start(
      fakeAccess(),
      fakeLlm(new EngineError('provider_unavailable', 'x')),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const last = parseSse(res.payload).at(-1);
    expect(last?.event).toBe('error');
    expect(last?.data).toMatchObject({ error: { code: 'provider_unavailable' } });
  });

  it('GET /v1/tools indica quais as ferramentas com streaming', async () => {
    const { app } = await start();
    const res = await app.inject({ method: 'GET', url: '/v1/tools', headers: AUTH });
    expect(res.json()).toMatchObject({ tools: [{ name: 'diagnostic', streaming: true }] });
  });
});

describe('limite de pedidos e interruptor de streaming', () => {
  const post = (a: FastifyInstance, payload: object, org = BODY.orgId) =>
    a.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: AUTH,
      payload: { ...BODY, orgId: org, ...payload },
    });

  it('429 rate_limited acima do limite da org, antes de gastar utilização', async () => {
    const { app, access } = await start(fakeAccess(), fakeLlm('{"reply":"Olá!"}'), {
      settings: { defaultModel: 'm', rateLimitPerMinute: 2 },
    });
    expect((await post(app, {})).statusCode).toBe(200);
    expect((await post(app, {})).statusCode).toBe(200);
    const res = await post(app, {});
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(access.calls).toHaveLength(2);
    // Outra org não é afetada.
    expect((await post(app, {}, '00DBBBBBBBBBBBBBBB')).statusCode).toBe(200);
  });

  it('sem limite configurado não recusa', async () => {
    const { app } = await start();
    for (let i = 0; i < 5; i++) expect((await post(app, {})).statusCode).toBe(200);
  });

  it('STREAM_ENABLED=false: stream:true dá 422 e a lista diz streaming:false', async () => {
    const { app, access } = await start(fakeAccess(), fakeLlm('{"reply":"Olá!"}'), {
      settings: { defaultModel: 'm', streamEnabled: false },
    });
    const res = await post(app, { stream: true });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { details: [{ path: 'body.stream' }] } });
    expect(access.calls).toHaveLength(0);
    expect((await post(app, {})).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v1/tools', headers: AUTH });
    expect(list.json()).toMatchObject({ tools: [{ streaming: false }] });
  });

  it('o streaming e o limite de pedidos seguem as definições em vigor, sem reiniciar', async () => {
    const live = { stream: true, limit: 0 };
    // Como no servidor: um objeto novo só quando as definições mudam.
    let settings: EngineSettings = { defaultModel: 'm' };
    const set = () => {
      settings = { defaultModel: 'm', streamEnabled: live.stream, rateLimitPerMinute: live.limit };
    };
    const { app } = await start(fakeAccess(), fakeLlm('{"reply":"Olá!"}'), {
      settings: () => settings,
    });
    const tools = () => app.inject({ method: 'GET', url: '/v1/tools', headers: AUTH });
    expect((await tools()).json()).toMatchObject({ tools: [{ streaming: true }] });
    live.stream = false;
    set();
    expect((await tools()).json()).toMatchObject({ tools: [{ streaming: false }] });
    expect((await post(app, { stream: true })).statusCode).toBe(422);

    for (let i = 0; i < 3; i++) expect((await post(app, {})).statusCode).toBe(200);
    // Sem limite não se conta nada: com limite 1, o primeiro passa e o segundo é recusado.
    live.limit = 1;
    set();
    expect((await post(app, {})).statusCode).toBe(200);
    expect((await post(app, {})).statusCode).toBe(429);
  });

  it('valores da ferramenta: limite próprio por org e ferramenta, streaming desligado só nela', async () => {
    const { app, access } = await start(fakeAccess(), fakeLlm('{"reply":"Olá!"}'), {
      settings: { defaultModel: 'm', rateLimitPerMinute: 100 },
      overrides: { rateLimitPerMinute: 1, streamEnabled: false },
    });
    expect((await post(app, {})).statusCode).toBe(200);
    const limited = await post(app, {});
    expect(limited.statusCode).toBe(429);
    expect(access.calls).toHaveLength(1);
    // Outra org tem a sua própria contagem.
    expect((await post(app, {}, '00DBBBBBBBBBBBBBBB')).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v1/tools', headers: AUTH });
    expect(list.json()).toMatchObject({ tools: [{ name: 'diagnostic', streaming: false }] });
    const streamed = await post(app, { stream: true }, '00DCCCCCCCCCCCCCCC');
    expect(streamed.json()).toMatchObject({
      error: { details: [{ issue: 'o streaming está desativado para esta ferramenta' }] },
    });
  });

  it('as métricas guardam o passo em que cada pedido parou', async () => {
    const metrics = new Metrics();
    app = await buildTestApp({
      engine: {
        engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], {
          access: fakeAccess().access,
          llm: fakeLlm('{"reply":"Olá!"}').llm,
          settings: { defaultModel: 'm', rateLimitPerMinute: 1 },
          ...fakeStore(),
        }),
        apiSecret: SECRET,
        metrics,
      },
    });
    expect((await post(app, {})).statusCode).toBe(200);
    expect((await post(app, {})).statusCode).toBe(429);
    expect((await post(app, { message: 5 })).statusCode).toBe(422);
    await app.inject({ method: 'POST', url: '/v1/tools/diagnostic', payload: BODY });
    expect(metrics.pipeline('diagnostic').stops).toMatchObject({
      auth: { unauthorized: 1 },
      request: { invalid_request: 1 },
      rate: { rate_limited: 1 },
    });
  });
});
