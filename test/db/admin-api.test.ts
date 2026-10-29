import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Metrics } from '../../src/engine/metrics.js';
import { PgEngineStore, syncToolCatalog } from '../../src/adapters/postgres-store.js';
import type { ToolDefinition } from '../../src/engine/tool.js';
import { diagnosticTool } from '../../src/tools/diagnostic.js';
import { fakeAccess, fakeLlm } from '../engine/fakes.js';
import { buildTestApp } from '../helpers.js';
import { TEST_DATABASE_URL, addMemory, createTestDb, sfId, type TestDb } from './helpers.js';

const SECRET = 'a'.repeat(40);
const READ = { authorization: `Bearer ${SECRET}` };
const WRITE = { ...READ, 'x-admin-actor': 'ricardo@stepahead.pt' };
const tool = diagnosticTool as unknown as ToolDefinition;

describe.skipIf(TEST_DATABASE_URL === undefined)('API de administração', () => {
  let db: TestDb;
  let app: FastifyInstance | undefined;
  let access: ReturnType<typeof fakeAccess>;
  let llm: ReturnType<typeof fakeLlm>;
  const metrics = new Metrics();

  beforeAll(async () => {
    db = await createTestDb();
    await syncToolCatalog(db.pool, ['diagnostic']);
  });
  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await app?.close();
    access = fakeAccess();
    llm = fakeLlm('{"reply":"Olá do playground"}');
    app = await buildTestApp({
      admin: {
        secret: SECRET,
        pool: db.pool,
        tools: [tool],
        defaultModel: 'google/gemini-2.5-flash',
        metrics,
        status: async () => ({ engine: { ready: true } }),
        models: {
          list: async () => ({
            fetchedAt: '2026-10-13T00:00:00.000Z',
            models: [
              {
                id: 'a',
                name: 'A',
                contextLength: 1,
                promptPricePerMillion: 1,
                completionPricePerMillion: 1,
                supportsStructuredOutput: true,
              },
              {
                id: 'b',
                name: 'B',
                contextLength: 1,
                promptPricePerMillion: 1,
                completionPricePerMillion: 1,
                supportsStructuredOutput: false,
              },
            ],
          }),
        },
        playground: { store: new PgEngineStore(db.pool), llm: llm.llm, access: access.access },
      },
    });
  });

  const ready = (): FastifyInstance => {
    if (app === undefined) throw new Error('app por criar');
    return app;
  };
  const get = (url: string) => ready().inject({ method: 'GET', url, headers: READ });
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    ready().inject({
      method,
      url,
      headers: WRITE,
      ...(payload !== undefined && { payload: payload as object }),
    });

  describe('autenticação', () => {
    it('sem credencial: 401', async () => {
      const res = await ready().inject({ method: 'GET', url: '/v1/admin/status' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    });

    it('as alterações exigem X-Admin-Actor', async () => {
      const res = await ready().inject({
        method: 'POST',
        url: '/v1/admin/memories',
        headers: READ,
        payload: { orgId: sfId('00D'), content: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { details: [{ path: 'headers.x-admin-actor' }] } });
    });
  });

  describe('estado, métricas e modelos', () => {
    it('devolve o estado montado pelo servidor', async () => {
      expect((await get('/v1/admin/status')).json()).toEqual({ engine: { ready: true } });
    });

    it('devolve as métricas agregadas', async () => {
      metrics.record({ tool: 'diagnostic', errorCode: undefined, durationMs: 10 });
      expect((await get('/v1/admin/metrics')).json()).toMatchObject({ totals: { requests: 1 } });
    });

    it('por omissão só lista modelos com JSON Schema', async () => {
      const ids = (url: string) =>
        get(url).then((r) => r.json<{ models: { id: string }[] }>().models.map((m) => m.id));
      expect(await ids('/v1/admin/models')).toEqual(['a']);
      expect(await ids('/v1/admin/models?structuredOnly=false')).toEqual(['a', 'b']);
    });
  });

  describe('ferramentas', () => {
    it('lista o catálogo e diz quais estão implementadas', async () => {
      const res = await get('/v1/admin/tools');
      const tools = res.json<{ tools: { name: string; implemented: boolean }[] }>().tools;
      expect(tools.map((t) => [t.name, t.implemented])).toEqual([
        ['diagnostic', true],
        ['reply', false],
        ['sentiment', false],
        ['tipification', false],
      ]);
      expect(tools[0]).toMatchObject({
        enabled: true,
        version: 1,
        config: { model: 'google/gemini-2.5-flash', temperature: 0.2, source: 'default' },
        prompt: { source: 'code', activeVersion: null, versionCount: 0 },
      });
    });

    it('detalhe com valores de origem, prompt do código e esquemas', async () => {
      const body = (await get('/v1/admin/tools/diagnostic')).json<Record<string, unknown>>();
      expect(body).toMatchObject({
        defaults: { model: 'google/gemini-2.5-flash', temperature: 0.2, maxOutputTokens: 300 },
        codePrompt: tool.systemPrompt,
        inputSchema: { type: 'object', required: ['message'] },
        outputSchema: { type: 'object', required: ['reply'] },
      });
    });

    it('grava e repõe a configuração', async () => {
      const saved = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        model: 'anthropic/claude-sonnet-4.5',
        temperature: 0.7,
        maxOutputTokens: 500,
        timeoutMs: 15000,
        enabled: false,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        enabled: false,
        config: { model: 'anthropic/claude-sonnet-4.5', temperature: 0.7, source: 'database' },
      });

      const reset = await send('DELETE', '/v1/admin/tools/diagnostic/config');
      expect(reset.json()).toMatchObject({ enabled: true, config: { source: 'default' } });
    });

    it('valida a configuração e recusa ferramentas desconhecidas', async () => {
      const bad = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        model: 'x',
        temperature: 3,
        maxOutputTokens: 500,
        timeoutMs: 15000,
        enabled: true,
      });
      expect(bad.statusCode).toBe(422);
      expect((await get('/v1/admin/tools/nao_existe')).json()).toMatchObject({
        error: { code: 'unknown_tool' },
      });
    });
  });

  describe('prompts', () => {
    it('cria versões, escolhe a ativa e volta ao prompt do código', async () => {
      const url = '/v1/admin/tools/reply/prompt-versions';
      const v1 = await send('POST', url, { systemTemplate: 'Primeira.', changeNote: 'início' });
      expect(v1.statusCode).toBe(201);
      expect(v1.json()).toMatchObject({ version: 1, isActive: false, changeNote: 'início' });

      const v2 = await send('POST', url, { systemTemplate: 'Segunda.', activate: true });
      expect(v2.json()).toMatchObject({ version: 2, isActive: true });

      const list = (await get(url)).json<{
        activeVersion: number;
        versions: { version: number }[];
      }>();
      expect(list.activeVersion).toBe(2);
      expect(list.versions.map((v) => v.version)).toEqual([2, 1]);

      await send('PUT', '/v1/admin/tools/reply/active-prompt', { version: 1 });
      expect((await get(url)).json()).toMatchObject({ activeVersion: 1 });

      await send('PUT', '/v1/admin/tools/reply/active-prompt', { version: null });
      expect((await get('/v1/admin/tools/reply')).json()).toMatchObject({
        prompt: { source: 'none', activeVersion: null, versionCount: 2 },
      });

      const missing = await send('PUT', '/v1/admin/tools/reply/active-prompt', { version: 99 });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('memórias', () => {
    it('cria, lista, filtra, altera e apaga memórias da org', async () => {
      const org = sfId('00D');
      const created = await send('POST', '/v1/admin/memories', {
        orgId: org,
        content: 'Tratar por você.',
        tools: ['reply'],
      });
      expect(created.statusCode).toBe(201);
      const memory = created.json<{ id: string }>();
      expect(memory).toMatchObject({
        scope: 'org',
        source: 'admin',
        orgId: org,
        userId: null,
        content: 'Tratar por você.',
        tools: ['reply'],
      });

      const user = sfId('005');
      await addMemory(db.pool, { org, user }, 'Assinar com o nome.');

      const all = (await get(`/v1/admin/memories?orgId=${org}`)).json<{ total: number }>();
      expect(all).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(
        (await get(`/v1/admin/memories?orgId=${org}&scope=user`))
          .json<{ items: { content: string }[] }>()
          .items.map((m) => m.content),
      ).toEqual(['Assinar com o nome.']);
      expect((await get(`/v1/admin/memories?orgId=${org}&tool=sentiment`)).json()).toMatchObject({
        total: 1,
      });
      expect((await get(`/v1/admin/memories?orgId=${org}&search=VOCÊ`)).json()).toMatchObject({
        total: 1,
      });
      expect((await get(`/v1/admin/memories?orgId=${org}&limit=1&offset=1`)).json()).toMatchObject({
        total: 2,
        items: [{ scope: 'user' }],
      });

      expect((await get(`/v1/admin/memories/summary?orgId=${org}`)).json()).toEqual({
        orgId: org,
        org: { count: 1, limit: 50 },
        users: [{ userId: user, count: 1, limit: 20 }],
      });

      const patched = await send('PATCH', `/v1/admin/memories/${memory.id}`, {
        content: 'Tratar sempre por você.',
        tools: [],
      });
      expect(patched.json()).toMatchObject({ content: 'Tratar sempre por você.', tools: [] });

      expect((await send('DELETE', `/v1/admin/memories/${memory.id}`)).statusCode).toBe(204);
      expect((await get(`/v1/admin/memories/${memory.id}`)).statusCode).toBe(404);
      expect((await send('DELETE', `/v1/admin/memories/${memory.id}`)).statusCode).toBe(404);
    });

    it('as memórias de utilizador não se alteram, só se apagam', async () => {
      const id = await addMemory(db.pool, { org: sfId('00D'), user: sfId('005') });
      const res = await send('PATCH', `/v1/admin/memories/${id}`, { content: 'outra' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
    });

    it('limite de memórias da org: 409 memory_limit_reached', async () => {
      const org = sfId('00D');
      for (let i = 0; i < 50; i++) await addMemory(db.pool, { org }, `m${String(i)}`);
      const res = await send('POST', '/v1/admin/memories', { orgId: org, content: 'a mais' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'memory_limit_reached' } });
    });

    it('purge apaga tudo de um utilizador, ou de uma org', async () => {
      const org = sfId('00D');
      const user = sfId('005');
      await addMemory(db.pool, { org, user });
      await addMemory(db.pool, { org });
      expect(
        (await send('POST', '/v1/admin/memories/purge', { orgId: org, userId: user })).json(),
      ).toEqual({
        deleted: 1,
      });
      expect((await send('POST', '/v1/admin/memories/purge', { orgId: org })).json()).toEqual({
        deleted: 1,
      });
    });

    it('valida ids e ferramentas', async () => {
      expect((await get('/v1/admin/memories/nao-e-uuid')).statusCode).toBe(422);
      expect((await get('/v1/admin/memories?orgId=00Dcurto')).statusCode).toBe(422);
      const res = await send('POST', '/v1/admin/memories', {
        orgId: sfId('00D'),
        content: 'x',
        tools: ['nao_existe'],
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('playground', () => {
    const body = (org: string, user: string) => ({
      orgId: org,
      userId: user,
      input: { message: 'Olá' },
    });

    it('pré-visualização: mostra o prompt final com as memórias, sem chamar o modelo', async () => {
      const org = sfId('00D');
      const user = sfId('005');
      await addMemory(db.pool, { org }, 'Responder a rimar.');
      const res = await send('POST', '/v1/admin/playground/diagnostic/preview', body(org, user));
      expect(res.statusCode).toBe(200);
      const json = res.json<{ prompt: { system: string; user: string } }>();
      expect(json).toMatchObject({ memories: { org: ['Responder a rimar.'], user: [] } });
      expect(json.prompt.system).toContain('- Responder a rimar.');
      expect(json.prompt.user).toBe('Olá');
      expect(llm.requests).toHaveLength(0);
      expect(access.calls).toHaveLength(0);
    });

    it('execução: chama o modelo sem contar utilização, e mostra as tentativas', async () => {
      const res = await send('POST', '/v1/admin/playground/diagnostic/run', {
        ...body(sfId('00D'), sfId('005')),
        model: 'outro/modelo',
        systemPrompt: 'Prompt de teste.',
      });
      expect(res.json()).toMatchObject({
        ok: true,
        result: { reply: 'Olá do playground' },
        countedUsage: false,
        settings: { model: 'outro/modelo' },
        prompt: { system: 'Prompt de teste.' },
        attempts: [{ valid: true, text: '{"reply":"Olá do playground"}' }],
      });
      expect(llm.requests[0]?.model).toBe('outro/modelo');
      expect(access.calls).toHaveLength(0);
    });

    it('countUsage conta no StepAccess', async () => {
      await send('POST', '/v1/admin/playground/diagnostic/run', {
        ...body(sfId('00D'), sfId('005')),
        countUsage: true,
      });
      expect(access.calls).toHaveLength(1);
    });

    it('resposta inválida: ok=false com as duas tentativas', async () => {
      llm = fakeLlm('não é json');
      await ready().close();
      app = await buildTestApp({
        admin: {
          secret: SECRET,
          pool: db.pool,
          tools: [tool],
          defaultModel: 'm',
          metrics,
          status: async () => ({}),
          models: { list: async () => ({ fetchedAt: '', models: [] }) },
          playground: { store: new PgEngineStore(db.pool), llm: llm.llm, access: undefined },
        },
      });
      const res = await send(
        'POST',
        '/v1/admin/playground/diagnostic/run',
        body(sfId('00D'), sfId('005')),
      );
      expect(res.json()).toMatchObject({
        ok: false,
        result: null,
        attempts: [{ valid: false }, { valid: false }],
      });
    });

    it('valida a entrada da ferramenta e recusa ferramentas sem implementação', async () => {
      const bad = await send('POST', '/v1/admin/playground/diagnostic/run', {
        orgId: sfId('00D'),
        userId: sfId('005'),
        input: { mensagem: 'x' },
      });
      expect(bad.statusCode).toBe(422);
      const paths = bad
        .json<{ error: { details: { path: string }[] } }>()
        .error.details.map((d) => d.path);
      expect(paths).toContain('body.input.message');

      const missing = await send(
        'POST',
        '/v1/admin/playground/reply/run',
        body(sfId('00D'), sfId('005')),
      );
      expect(missing.json()).toMatchObject({ error: { code: 'unknown_tool' } });
    });
  });
});
