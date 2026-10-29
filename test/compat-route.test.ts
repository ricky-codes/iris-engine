import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Metrics } from '../src/engine/metrics.js';
import type { CostEvent } from '../src/engine/usage.js';
import type { ToolDefinition } from '../src/engine/tool.js';
import { EngineError } from '../src/engine/errors.js';
import { sentimentTool } from '../src/tools/sentiment.js';
import { fakeAccess, fakeEngine, fakeLlm } from './engine/fakes.js';
import { buildTestApp } from './helpers.js';

const SECRET = 's'.repeat(40);
const AUTH = { authorization: `Bearer ${SECRET}` };
const RESULT = {
  sentiment: 'Negativo',
  score: 0.86,
  summary: 'O cliente está frustrado.',
  signals: ['Pede resposta urgente'],
  urgency: 'Alta',
  recommendedTone: 'Empático e resolutivo',
};
const BODY = {
  action: 'sentiment',
  orgId: '00DAAAAAAAAAAAAAAA',
  userId: '005AAAAAAAAAAAAAAA',
  orgUrl: 'https://x.my.salesforce.com',
  recordId: '500AAAAAAAAAAAAAAA',
  ts: '2026-10-23T10:00:00Z',
  case: { Subject: 'Atraso', Description: 'Ninguém responde, é inaceitável.' },
  account: null,
  contact: { Name: 'Ana', Email: 'ana@exemplo.pt' },
  relatedCases: [],
  caseComments: [{ body: 'Vamos ver', isPublished: true }],
  emailMessages: [
    {
      incoming: true,
      fromAddress: 'ana@exemplo.pt',
      textBody: 'Escrevo a ana@exemplo.pt outra vez',
    },
  ],
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(access = fakeAccess(), metrics?: Metrics) {
  const llm = fakeLlm(JSON.stringify(RESULT));
  const costs: CostEvent[] = [];
  app = await buildTestApp({
    engine: {
      engine: fakeEngine([sentimentTool as unknown as ToolDefinition], {
        access: access.access,
        llm: llm.llm,
        usage: { report: (e) => costs.push(e) },
      }),
      apiSecret: SECRET,
      ...(metrics && { metrics }),
    },
  });
  return { app, access, llm, costs };
}

const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH) =>
  a.inject({ method: 'POST', url: '/v1/compat/n8n', headers, payload: payload as object });

describe('POST /v1/compat/n8n', () => {
  it('responde com o envelope {success, data} do Hub', async () => {
    const { app } = await start();
    const res = await post(app, BODY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: RESULT });
  });

  it('ignora os campos que a ferramenta não declara (payload, orgUrl, recordId…)', async () => {
    const { app, llm } = await start();
    const res = await post(app, {
      ...BODY,
      payload: { qualquer: 'coisa' },
      orgUrl: 'https://exemplo.my.salesforce.com',
      recordId: '500AAAAAAAAAAAAAAA',
    });
    expect(res.statusCode).toBe(200);
    expect(llm.requests[0]?.user ?? '').not.toContain('qualquer');
  });

  it('envia o custo com o mesmo id do X-Request-Id', async () => {
    const { app, costs } = await start();
    const res = await post(app, BODY);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ requestId: res.headers['x-request-id'], tool: 'sentiment' });
  });

  it('não envia ao modelo emails nem moradas de email', async () => {
    const { app, llm } = await start();
    await post(app, BODY);
    const sent = llm.requests[0]?.user ?? '';
    expect(sent).not.toContain('ana@exemplo.pt');
    expect(sent).not.toContain('fromAddress');
    expect(sent).toContain('email recebido do cliente');
    expect(sent).toContain('comentário publicado');
    expect(sent).toContain('Ninguém responde');
  });

  it('401 sem credencial, no envelope não: o erro de autenticação não revela nada', async () => {
    const { app, access } = await start();
    const res = await post(app, BODY, {});
    expect(res.statusCode).toBe(401);
    expect(access.calls).toHaveLength(0);
  });

  it('erros saem no envelope {success:false, error}', async () => {
    const { app } = await start(fakeAccess(new EngineError('access_denied', 'Sem acesso.')));
    const res = await post(app, BODY);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      success: false,
      error: { code: 'access_denied', message: 'Sem acesso.' },
    });
  });

  it('422 com ids inválidos ou ação desconhecida, sem gastar utilização', async () => {
    const { app, access } = await start();
    const badId = await post(app, { ...BODY, userId: '005curto' });
    expect(badId.statusCode).toBe(422);
    const unknown = await post(app, { ...BODY, action: 'xpto' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ success: false });
    expect(access.calls).toHaveLength(0);
  });

  it.each(['tipification', 'reply', 'knowledge'])(
    '501 not_implemented para "%s", sem gastar utilização',
    async (action) => {
      const { app, access } = await start();
      const res = await post(app, { ...BODY, action });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ success: false, error: { code: 'not_implemented' } });
      expect(access.calls).toHaveLength(0);
    },
  );

  it('aceita campos a null e em falta (o Apex envia null quando não há dados)', async () => {
    const { app } = await start();
    const res = await post(app, {
      action: 'sentiment',
      orgId: BODY.orgId,
      userId: BODY.userId,
      case: null,
      relatedCases: null,
    });
    expect(res.statusCode).toBe(200);
  });

  it('conta o pedido nas métricas, também quando falha', async () => {
    const metrics = new Metrics();
    const { app } = await start(fakeAccess(new EngineError('quota_exceeded', 'Limite.')), metrics);
    await post(app, BODY);
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.stringify(metrics.snapshot())).toContain('quota_exceeded');
  });
});
