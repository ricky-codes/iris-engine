import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RuntimeFacts, Topology } from '../../src/admin/topology.js';
import { Metrics } from '../../src/engine/metrics.js';
import { PgMemoryStore } from '../../src/adapters/postgres-memory-store.js';
import { collectTopology } from '../../src/admin/topology-source.js';
import { createEngine } from '../../src/engine/engine.js';
import { EngineError } from '../../src/engine/errors.js';
import { PgEngineStore, syncToolCatalog } from '../../src/adapters/postgres-store.js';
import type { ToolDefinition } from '../../src/engine/tool.js';
import { diagnosticTool } from '../../src/tools/diagnostic.js';
import { fakeAccess, fakeLlm } from '../engine/fakes.js';
import { PgSettingsStore } from '../../src/adapters/postgres-settings-store.js';
import type { LiveSettings } from '../../src/settings/settings.js';
import { buildTestApp, testSettings } from '../helpers.js';
import { OrgKeys } from '../../src/auth/org-keys.js';
import { signOrgToken } from '../../src/auth/org-token.js';
import { PgOrgKeyStore, SecretBox } from '../../src/adapters/postgres-org-key-store.js';
import { TEST_DATABASE_URL, addMemory, createTestDb, sfId, type TestDb } from './helpers.js';

const SECRET = 'a'.repeat(40);
const READ = { authorization: `Bearer ${SECRET}` };
const WRITE = { ...READ, 'x-admin-actor': 'ricardo@stepahead.pt' };
const tool = diagnosticTool as unknown as ToolDefinition;
const RUNTIME: RuntimeFacts = {
  service: {
    name: 'iris-engine',
    version: '0.1.0',
    environment: 'test',
    startedAt: '2026-11-02T00:00:00.000Z',
    uptimeSeconds: 1,
  },
  engine: { ready: true, missing: [], defaultModel: 'google/gemini-2.5-flash', maxAttempts: 2 },
  access: 'open',
  openRouter: 'configured',
  routes: { tools: true, memories: true },
  checks: {
    database: { status: 'ok', latencyMs: 1 },
    stepAccess: { status: 'not_configured', latencyMs: null },
    openRouter: { status: 'ok', latencyMs: 1 },
  },
};

describe.skipIf(TEST_DATABASE_URL === undefined)('API de administração', () => {
  let db: TestDb;
  let app: FastifyInstance | undefined;
  let access: ReturnType<typeof fakeAccess>;
  let llm: ReturnType<typeof fakeLlm>;
  let settings: LiveSettings;
  let core: ReturnType<typeof createEngine>;
  const metrics = new Metrics();
  let orgKeys: OrgKeys;

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
    // Cada teste começa sem definições gravadas.
    await db.pool.query('DELETE FROM engine_setting');
    settings = testSettings({}, new PgSettingsStore(db.pool));
    await settings.refresh();
    orgKeys = new OrgKeys(new PgOrgKeyStore(db.pool, new SecretBox(Buffer.alloc(32, 3))));
    core = createEngine({
      settings: () => settings.current(),
      tools: [tool],
      store: new PgEngineStore(db.pool),
      memories: new PgMemoryStore(db.pool),
      llm: llm.llm,
      access: access.access,
    });
    app = await buildTestApp({
      admin: {
        secret: SECRET,
        pool: db.pool,
        tools: [tool],
        settings,
        breakers: { status: () => core.breakers(), reset: (m) => core.resetBreakers(m) },
        instanceId: 'teste:1',
        metrics,
        status: async () => ({ engine: { ready: true } }),
        topology: () =>
          collectTopology({
            pool: db.pool,
            runtime: async () => RUNTIME,
            tools: [tool],
            settings: () => settings.current(),
            metrics,
            breakers: () => [],
          }),
        modules: async () => {
          throw new Error('não usado');
        },
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
        playground: { engine: core, countsUsage: true },
        orgKeys,
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

  describe('alertas (removidos)', () => {
    it('as rotas já não existem e nada fala de alertas nem de webhook', async () => {
      expect((await get('/v1/admin/alerts')).statusCode).toBe(404);
      expect((await send('POST', '/v1/admin/alerts/test')).statusCode).toBe(404);
      for (const url of ['/v1/admin/topology', '/v1/admin/settings']) {
        expect((await get(url)).payload).not.toMatch(/alert|webhook/i);
      }
    });
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

    it('descreve a topologia a partir do catálogo, das memórias e das métricas', async () => {
      await addMemory(db.pool, { org: sfId('00D') }, 'regra');
      await addMemory(db.pool, { org: sfId('00D'), user: sfId('005') }, 'preferência');
      const res = await get('/v1/admin/topology');
      expect(res.statusCode).toBe(200);
      const t = res.json<Topology>();
      expect(t.service.name).toBe('iris-engine');
      const byId = new Map(t.nodes.map((n) => [n.id, n]));
      expect(byId.get('tool.diagnostic')).toMatchObject({
        status: 'ok',
        label: 'diagnostic v1',
        details: { implemented: true, prompt: 'código' },
        configure: { where: 'admin_api', path: '/v1/admin/tools/diagnostic' },
      });
      expect(byId.get('tool.diagnostic')?.details.requests).toBe(0);
      expect(byId.get('adapter.access')).toMatchObject({ label: 'OpenAccessChecker' });
      expect(byId.get('core.memories')?.details.org).toBeGreaterThanOrEqual(1);
      expect(byId.get('core.memories')?.details.user).toBeGreaterThanOrEqual(1);
      expect((await ready().inject({ method: 'GET', url: '/v1/admin/topology' })).statusCode).toBe(
        401,
      );
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

  describe('definições', () => {
    type Settings = {
      refreshSeconds: number;
      settings: { key: string; value: unknown; source: string; updatedBy: string | null }[];
    };
    const byKey = (body: Settings) => new Map(body.settings.map((v) => [v.key, v]));

    it('lista as quinze definições, com o valor em vigor e de onde vem', async () => {
      const body = (await get('/v1/admin/settings')).json<Settings>();
      expect(body.refreshSeconds).toBe(30);
      expect(body.settings).toHaveLength(15);
      expect(byKey(body).get('defaultModel')).toMatchObject({
        value: 'google/gemini-2.5-flash',
        source: 'env',
        updatedBy: null,
      });
      expect(byKey(body).get('memoryPerOrg')).toMatchObject({ value: 50, source: 'code' });
    });

    it('grava, aplica já ao motor e regista quem mudou; null volta ao valor inicial', async () => {
      const res = await send('PATCH', '/v1/admin/settings', {
        defaultModel: 'a',
        maxAttempts: 4,
        breakerThreshold: 5,
      });
      expect(res.statusCode).toBe(200);
      expect(byKey(res.json<Settings>()).get('maxAttempts')).toMatchObject({
        value: 4,
        source: 'database',
        updatedBy: 'ricardo@stepahead.pt',
      });
      expect(core.settings).toMatchObject({
        defaultModel: 'a',
        maxAttempts: 4,
        breakerThreshold: 5,
      });
      // Ferramentas sem configuração passam a mostrar o novo modelo por omissão.
      expect((await get('/v1/admin/tools/diagnostic')).json()).toMatchObject({
        defaults: { model: 'a' },
      });
      const { rows } = await db.pool.query<{ key: string }>(
        'SELECT key FROM engine_setting ORDER BY key',
      );
      expect(rows.map((r) => r.key)).toEqual(['breakerThreshold', 'defaultModel', 'maxAttempts']);

      const reset = await send('PATCH', '/v1/admin/settings', { maxAttempts: null });
      expect(byKey(reset.json<Settings>()).get('maxAttempts')).toMatchObject({
        value: 2,
        source: 'env',
      });
      expect(core.settings.maxAttempts).toBe(2);
    });

    it('recusa valores inválidos, definições desconhecidas e modelos fora do catálogo, sem gravar nada', async () => {
      const bad = await send('PATCH', '/v1/admin/settings', {
        maxAttempts: 9,
        nope: true,
        streamEnabled: false,
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({
        error: { details: [{ path: 'body.maxAttempts' }, { path: 'body.nope' }] },
      });
      const model = await send('PATCH', '/v1/admin/settings', {
        defaultModel: 'b',
        fallbackModels: ['zzz'],
      });
      expect(model.statusCode).toBe(422);
      expect(model.json()).toMatchObject({
        error: {
          details: [
            { path: 'body.defaultModel', issue: 'não suporta respostas com JSON Schema' },
            {
              path: 'body.fallbackModels.0',
              issue: 'não existe no catálogo de modelos do OpenRouter',
            },
          ],
        },
      });
      expect((await send('PATCH', '/v1/admin/settings', {})).statusCode).toBe(422);
      const { rows } = await db.pool.query('SELECT 1 FROM engine_setting');
      expect(rows).toHaveLength(0);
      expect(core.settings.maxAttempts).toBe(2);
    });

    it('os limites das memórias valem logo, também na base de dados', async () => {
      const org = sfId('00D');
      await send('PATCH', '/v1/admin/settings', { memoryPerOrg: 1, memoryMaxChars: 50 });
      const create = (content: string) =>
        send('POST', '/v1/admin/memories', { orgId: org, content });
      expect((await create('x'.repeat(51))).json()).toMatchObject({
        error: { code: 'invalid_request', message: 'No máximo 50 caracteres.' },
      });
      expect((await create('regra')).statusCode).toBe(201);
      const second = await create('outra');
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: { message: `A org ${org} já tem 1 memórias. Apague uma antes de criar outra.` },
      });
      expect((await get(`/v1/admin/memories/summary?orgId=${org}`)).json()).toMatchObject({
        org: { count: 1, limit: 1 },
      });
    });

    it('fecha o disjuntor à mão: um modelo ou todos', async () => {
      llm = fakeLlm(new EngineError('provider_unavailable', 'Indisponível.'));
      core = createEngine({
        settings: { defaultModel: 'google/gemini-2.5-flash', breakerThreshold: 1 },
        tools: [tool],
        store: new PgEngineStore(db.pool),
        memories: new PgMemoryStore(db.pool),
        llm: llm.llm,
        access: access.access,
      });
      await core
        .run('diagnostic', { orgId: sfId('00D'), userId: sfId('005'), input: { message: 'x' } })
        .catch(() => undefined);
      expect(core.openBreakers()).toMatchObject([{ model: 'google/gemini-2.5-flash' }]);

      const one = await send('POST', '/v1/admin/breakers/reset?model=outro%2Fmodelo');
      expect(one.json()).toEqual({ closed: [] });
      const all = await send('POST', '/v1/admin/breakers/reset');
      expect(all.statusCode).toBe(200);
      expect(all.json()).toEqual({ closed: ['google/gemini-2.5-flash'] });
      expect(core.openBreakers()).toEqual([]);
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

    it('grava modelos de recurso por ordem, devolve-os e substitui-os por inteiro', async () => {
      const config = {
        model: 'anthropic/claude-sonnet-4.5',
        temperature: 0.2,
        maxOutputTokens: 300,
        timeoutMs: 15000,
        enabled: true,
      };
      const saved = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        ...config,
        fallbackModels: ['a'],
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ config: { fallbackModels: ['a'], source: 'database' } });
      const listed = (await get('/v1/admin/tools')).json<{ tools: { name: string }[] }>();
      expect(listed.tools.find((t) => t.name === 'diagnostic')).toMatchObject({
        config: { fallbackModels: ['a'] },
      });
      expect(
        await new PgEngineStore(db.pool).settingsFor('diagnostic', tool.defaults, {
          model: 'm',
          fallbackModels: ['outro'],
        }),
      ).toMatchObject({ model: 'anthropic/claude-sonnet-4.5', fallbackModels: ['a'] });

      // A omissão de fallbackModels apaga os que existiam.
      const cleared = await send('PUT', '/v1/admin/tools/diagnostic/config', config);
      expect(cleared.json()).toMatchObject({ config: { fallbackModels: [] } });
      await send('DELETE', '/v1/admin/tools/diagnostic/config');
      expect((await get('/v1/admin/tools/diagnostic')).json()).toMatchObject({
        config: { source: 'default', fallbackModels: [] },
        defaults: { fallbackModels: [] },
      });
    });

    it.each([
      ['repetidos', ['a', 'a'], 'repetido'],
      ['igual ao principal', ['anthropic/claude-sonnet-4.5'], 'é o modelo principal'],
      ['inexistente', ['nao/existe'], 'não existe no catálogo de modelos do OpenRouter'],
      ['sem JSON Schema', ['b'], 'não suporta respostas com JSON Schema'],
    ])('recusa modelos de recurso %s, sem gravar nada', async (_label, fallbackModels, issue) => {
      const res = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        model: 'anthropic/claude-sonnet-4.5',
        temperature: 0.2,
        maxOutputTokens: 300,
        timeoutMs: 15000,
        enabled: true,
        fallbackModels,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: {
          code: 'invalid_request',
          message: 'Os modelos de recurso não são válidos.',
          details: [{ issue }],
        },
      });
      expect((await get('/v1/admin/tools/diagnostic')).json()).toMatchObject({
        config: { source: 'default' },
      });
    });

    it('recusa mais de 3 modelos de recurso', async () => {
      const res = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        model: 'x',
        temperature: 0.2,
        maxOutputTokens: 300,
        timeoutMs: 15000,
        enabled: true,
        fallbackModels: ['a', 'b', 'c', 'd'],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { details: [{ path: 'body.fallbackModels' }] } });
    });

    it('a base de dados recusa o modelo principal como modelo de recurso', async () => {
      await send('PUT', '/v1/admin/tools/diagnostic/config', {
        model: 'anthropic/claude-sonnet-4.5',
        temperature: 0.2,
        maxOutputTokens: 300,
        timeoutMs: 15000,
        enabled: true,
      });
      await expect(
        db.pool.query(
          `INSERT INTO tool_config_fallback (tool_id, position, llm_model_id)
           SELECT tool_id, 1, llm_model_id FROM tool_config
           WHERE tool_id = (SELECT tool_id FROM tool WHERE code = 'diagnostic')`,
        ),
      ).rejects.toThrow(/fallback_is_main/);
      await send('DELETE', '/v1/admin/tools/diagnostic/config');
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

  describe('valores por ferramenta, pipeline e disjuntores', () => {
    const config = {
      model: 'a',
      temperature: 0.2,
      maxOutputTokens: 300,
      timeoutMs: 15000,
      enabled: true,
    };
    type Overrides = Record<string, { value: unknown; source: string }>;

    it('grava, mostra a origem de cada valor, aplica no motor e null volta à global', async () => {
      const saved = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        ...config,
        maxAttempts: 4,
        rateLimitPerMinute: 0,
        streamEnabled: null,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ config: { overrides: Overrides } }>().config.overrides).toEqual({
        maxAttempts: { value: 4, source: 'tool' },
        totalTimeoutMs: { value: 30_000, source: 'engine' },
        rateLimitPerMinute: { value: 0, source: 'tool' },
        streamEnabled: { value: true, source: 'engine' },
      });
      const listed = (await get('/v1/admin/tools')).json<{
        tools: { name: string; config: { overrides: Overrides } | null }[];
      }>();
      expect(
        listed.tools.find((t) => t.name === 'diagnostic')?.config?.overrides.maxAttempts,
      ).toEqual({
        value: 4,
        source: 'tool',
      });
      // O playground mostra os valores em vigor para esta ferramenta.
      const run = await send('POST', '/v1/admin/playground/diagnostic/preview', {
        orgId: sfId('00D'),
        userId: sfId('005'),
        input: { message: 'olá' },
      });
      expect(run.json()).toMatchObject({
        settings: {
          maxAttempts: 4,
          rateLimitPerMinute: 0,
          streamEnabled: true,
          overrides: { maxAttempts: 4, totalTimeoutMs: null, streamEnabled: null },
        },
      });

      // Sem os campos, voltam à definição global.
      const cleared = await send('PUT', '/v1/admin/tools/diagnostic/config', config);
      expect(
        cleared.json<{ config: { overrides: Overrides } }>().config.overrides.maxAttempts,
      ).toEqual({
        value: 2,
        source: 'engine',
      });
      await send('DELETE', '/v1/admin/tools/diagnostic/config');
    });

    it('recusa valores fora dos limites com as mensagens de PATCH /settings, e campos a mais', async () => {
      const bad = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        ...config,
        maxAttempts: 9,
        totalTimeoutMs: 1000,
        rateLimitPerMinute: -1,
        streamEnabled: 'sim',
      });
      expect(bad.statusCode).toBe(422);
      const details = bad.json<{ error: { details: { path: string; issue: string }[] } }>().error
        .details;
      expect(details.map((d) => d.path)).toEqual([
        'body.maxAttempts',
        'body.totalTimeoutMs',
        'body.rateLimitPerMinute',
        'body.streamEnabled',
      ]);
      const viaSettings = await send('PATCH', '/v1/admin/settings', { maxAttempts: 9 });
      expect(details[0]?.issue).toBe(
        viaSettings.json<{ error: { details: { issue: string }[] } }>().error.details[0]?.issue,
      );
      const extra = await send('PUT', '/v1/admin/tools/diagnostic/config', { ...config, nope: 1 });
      expect(extra.statusCode).toBe(422);
      expect((await get('/v1/admin/tools/diagnostic')).json()).toMatchObject({
        config: { source: 'default' },
      });
    });

    it('pipeline: os passos pela ordem do código, o que controla cada um e a cadeia de modelos', async () => {
      const saved = await send('PUT', '/v1/admin/tools/diagnostic/config', {
        ...config,
        model: 'outro/modelo',
        fallbackModels: ['a'],
        rateLimitPerMinute: 7,
      });
      expect(saved.statusCode).toBe(200);
      const res = await get('/v1/admin/tools/diagnostic/pipeline');
      expect(res.statusCode).toBe(200);
      const p = res.json<{
        tool: string;
        since: string;
        stages: {
          id: string;
          status: string;
          counts: { passed: number; stopped: number };
          toolConfig: string[];
          settings: string[];
          overrides: string[];
          env: string[];
          details: Record<string, unknown>;
        }[];
        models: { model: string; role: string; breaker: { state: string } }[];
      }>();
      expect(p.tool).toBe('diagnostic');
      expect(p.since).toBe(metrics.since);
      expect(p.stages.map((x) => x.id)).toEqual([
        'auth',
        'request',
        'gate',
        'rate',
        'access',
        'memories',
        'prompt',
        'models',
        'validate',
        'response',
      ]);
      const stage = (id: string) => p.stages.find((x) => x.id === id);
      expect(stage('gate')).toMatchObject({ status: 'ok', toolConfig: ['enabled'] });
      expect(stage('rate')).toMatchObject({
        settings: ['rateLimitPerMinute'],
        overrides: ['rateLimitPerMinute'],
        details: { limitPerMinute: 7, source: 'tool' },
      });
      expect(stage('access')).toMatchObject({ details: { mode: 'open', latencyMs: null } });
      expect(stage('access')?.env).toContain('STEPACCESS_PASSWORD');
      expect(stage('prompt')).toMatchObject({ details: { source: 'code', activeVersion: null } });
      expect(stage('validate')).toMatchObject({
        details: { maxAttempts: 2, maxAttemptsSource: 'engine' },
      });
      expect(p.models.map((m) => [m.model, m.role, m.breaker.state])).toEqual([
        ['outro/modelo', 'primary', 'closed'],
        ['a', 'fallback', 'closed'],
      ]);
      // Nunca valores do .env, segredos nem ids.
      expect(res.payload).not.toMatch(/00D[A-Za-z0-9]{15}|Bearer|sk-or/);
      await send('DELETE', '/v1/admin/tools/diagnostic/config');
    });

    it('pipeline de uma ferramenta sem implementação: passos off e sem modelos; desconhecida: 404', async () => {
      const p = (await get('/v1/admin/tools/sentiment/pipeline')).json<{
        stages: { status: string; summary: string }[];
        models: unknown[];
      }>();
      expect(new Set(p.stages.map((x) => x.status))).toEqual(new Set(['off']));
      expect(p.stages[0]?.summary).toBe('Sem implementação neste servidor');
      expect(p.models).toEqual([]);
      const missing = await get('/v1/admin/tools/nao_existe/pipeline');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: 'unknown_tool' } });
    });

    it('disjuntores: estado completo de cada modelo chamado, por instância', async () => {
      expect((await get('/v1/admin/breakers')).json()).toEqual({
        instanceId: 'teste:1',
        breakers: [],
      });
      llm = fakeLlm(new EngineError('provider_unavailable', 'Indisponível.'));
      core = createEngine({
        settings: { defaultModel: 'google/gemini-2.5-flash', breakerThreshold: 1 },
        tools: [tool],
        store: new PgEngineStore(db.pool),
        memories: new PgMemoryStore(db.pool),
        llm: llm.llm,
        access: access.access,
      });
      await core
        .run('diagnostic', { orgId: sfId('00D'), userId: sfId('005'), input: { message: 'x' } })
        .catch(() => undefined);
      const body = (await get('/v1/admin/breakers')).json<{
        breakers: Record<string, unknown>[];
      }>();
      expect(body.breakers).toHaveLength(1);
      expect(body.breakers[0]).toMatchObject({
        model: 'google/gemini-2.5-flash',
        state: 'open',
        consecutiveFailures: 1,
        lastError: { reason: 'provider_unavailable' },
      });
      expect(Object.keys(body.breakers[0] ?? {}).sort()).toEqual([
        'consecutiveFailures',
        'failures',
        'lastError',
        'model',
        'openUntil',
        'openedAt',
        'reopensAt',
        'state',
        'threshold',
      ]);
      expect(typeof body.breakers[0]?.['openUntil']).toBe('string');
      await send('POST', '/v1/admin/breakers/reset');
      expect((await get('/v1/admin/breakers')).json()).toMatchObject({
        breakers: [{ state: 'closed', consecutiveFailures: 0, openedAt: null, openUntil: null }],
      });
      // O pipeline mostra o disjuntor da cadeia.
      expect((await get('/v1/admin/tools/diagnostic/pipeline')).json()).toMatchObject({
        models: [{ model: 'google/gemini-2.5-flash', breaker: { state: 'closed' } }],
      });
    });
  });

  describe('dashboard: catálogo de erros, traces, dry-run e fluxo nas métricas', () => {
    it('GET /errors: os códigos estáveis com o passo e o estado HTTP', async () => {
      const { errors } = (await get('/v1/admin/errors')).json<{
        errors: { code: string; stage: string; httpStatus: number; publicCode: string }[];
      }>();
      const byCode = new Map(errors.map((e) => [e.code, e]));
      for (const code of [
        'tool_disabled',
        'rate_limited',
        'access_denied',
        'quota_exceeded',
        'stepaccess_unavailable',
        'model_timeout',
        'provider_error',
        'all_models_failed',
        'invalid_output',
      ])
        expect(byCode.has(code)).toBe(true);
      expect(byCode.get('stepaccess_unavailable')).toMatchObject({
        stage: 'access',
        httpStatus: 503,
        publicCode: 'service_unavailable',
      });
    });

    it('pipeline: kind, saídas de cada passo e a cadeia curta', async () => {
      const p = (await get('/v1/admin/tools/diagnostic/pipeline')).json<{
        stages: { id: string; kind: string; exits: { code: string }[] }[];
        modelChain: { model: string; role: string; order: number; breaker: string }[];
      }>();
      expect(p.stages.find((x) => x.id === 'models')).toMatchObject({ kind: 'model' });
      const auth = p.stages.find((x) => x.id === 'auth');
      expect(auth).toMatchObject({ kind: 'auth' });
      expect(auth?.exits.map((e) => e.code)).toContain('token_expired');
      expect(p.stages.find((x) => x.id === 'access')?.exits.map((e) => e.code)).toEqual([
        'access_denied',
        'quota_exceeded',
        'stepaccess_unavailable',
      ]);
      expect(p.modelChain).toEqual([
        { model: 'google/gemini-2.5-flash', role: 'primary', order: 0, breaker: 'closed' },
      ]);
    });

    it('traces: vazios sem módulo; ferramenta desconhecida 404; limite validado', async () => {
      expect((await get('/v1/admin/tools/diagnostic/traces')).json()).toEqual({
        tool: 'diagnostic',
        instanceId: 'teste:1',
        enabled: false,
        traces: [],
      });
      expect((await get('/v1/admin/tools/nao_existe/traces')).statusCode).toBe(404);
      expect((await get('/v1/admin/tools/diagnostic/traces?limit=0')).statusCode).toBe(422);
    });

    it('dry-run: os passos de entrada e de contexto, o tamanho do prompt e as memórias', async () => {
      const org = sfId('00D');
      await send('POST', '/v1/admin/memories', { orgId: org, content: 'Tratar por você.' });
      const res = await send('POST', '/v1/admin/tools/diagnostic/dry-run', {
        orgId: org,
        userId: sfId('005'),
        input: { message: 'olá' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        path: { stage: string; skipped?: boolean }[];
        prompt: { systemChars: number; userChars: number; estimatedTokens: number };
        memories: { org: number; user: number };
      }>();
      expect(body.path.map((x) => x.stage)).toEqual([
        'request',
        'gate',
        'rate',
        'access',
        'memories',
        'prompt',
      ]);
      expect(body.memories).toEqual({ org: 1, user: 0 });
      expect(body.prompt.estimatedTokens).toBe(
        Math.ceil((body.prompt.systemChars + body.prompt.userChars) / 4),
      );
      // Nada de texto do prompt nem chamada ao modelo.
      expect(res.payload).not.toContain('Tratar por você');
      expect(llm.requests).toHaveLength(0);
      expect(access.calls).toHaveLength(0);
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
        settings: { model: 'outro/modelo', maxAttempts: 2, streamEnabled: true },
        timings: { access: 0 },
        prompt: { system: 'Prompt de teste.' },
        attempts: [
          {
            valid: true,
            text: '{"reply":"Olá do playground"}',
            reason: 'ok',
            fallback: false,
            requestedModel: 'outro/modelo',
          },
        ],
      });
      expect(llm.requests[0]?.model).toBe('outro/modelo');
      expect(access.calls).toHaveLength(0);
    });

    it('a execução devolve o tempo de cada passo', async () => {
      const res = await send(
        'POST',
        '/v1/admin/playground/diagnostic/run',
        body(sfId('00D'), sfId('005')),
      );
      const timings = res.json<{ timings: Record<string, number> }>().timings;
      expect(Object.keys(timings)).toEqual([
        'gate',
        'rate',
        'access',
        'memories',
        'prompt',
        'models',
        'validate',
      ]);
      expect(Object.values(timings).every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
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
          settings: testSettings(),
          breakers: undefined,
          instanceId: 'teste:1',
          metrics,
          status: async () => ({}),
          topology: async () => {
            throw new Error('não usado');
          },
          modules: async () => {
            throw new Error('não usado');
          },
          models: { list: async () => ({ fetchedAt: '', models: [] }) },
          playground: {
            engine: createEngine({
              settings: { defaultModel: 'm' },
              tools: [tool],
              store: new PgEngineStore(db.pool),
              memories: new PgMemoryStore(db.pool),
              llm: llm.llm,
              access: { check: async () => undefined },
            }),
            countsUsage: false,
          },
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
        error: { code: 'invalid_model_output' },
      });
    });

    it('com o fornecedor em baixo, passa ao modelo de recurso indicado e mostra o motivo', async () => {
      llm = fakeLlm(
        new EngineError('provider_unavailable', 'Indisponível.'),
        '{"reply":"Do recurso"}',
      );
      await ready().close();
      app = await buildTestApp({
        admin: {
          secret: SECRET,
          pool: db.pool,
          tools: [tool],
          settings: testSettings(),
          breakers: undefined,
          instanceId: 'teste:1',
          metrics,
          status: async () => ({}),
          topology: async () => {
            throw new Error('não usado');
          },
          modules: async () => {
            throw new Error('não usado');
          },
          models: { list: async () => ({ fetchedAt: '', models: [] }) },
          playground: {
            engine: createEngine({
              settings: { defaultModel: 'm' },
              tools: [tool],
              store: new PgEngineStore(db.pool),
              memories: new PgMemoryStore(db.pool),
              llm: llm.llm,
              access: { check: async () => undefined },
            }),
            countsUsage: false,
          },
        },
      });
      const res = await send('POST', '/v1/admin/playground/diagnostic/run', {
        ...body(sfId('00D'), sfId('005')),
        fallbackModelsOverride: ['outro/recurso'],
      });
      expect(res.json()).toMatchObject({
        ok: true,
        error: null,
        result: { reply: 'Do recurso' },
        settings: { model: 'm', fallbackModels: ['outro/recurso'] },
        attempts: [
          { requestedModel: 'm', reason: 'provider_unavailable', fallback: false, text: null },
          { requestedModel: 'outro/recurso', reason: 'ok', fallback: true },
        ],
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
  describe('chaves das orgs', () => {
    const base = (org: string) => `/v1/admin/orgs/${org}/keys`;

    it('cria uma chave: o segredo aparece uma vez e fica cifrado na base de dados', async () => {
      const org = sfId('00D');
      const res = await app!.inject({ method: 'POST', url: base(org), headers: WRITE });
      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json<{ kid: string; secret: string; createdBy: string; status: string }>();
      expect(body).toMatchObject({
        orgId: org,
        status: 'active',
        createdBy: 'ricardo@stepahead.pt',
      });

      const { rows } = await db.pool.query<{ secret_enc: Buffer }>(
        'SELECT secret_enc FROM org_key WHERE org_key_id = $1',
        [body.kid],
      );
      expect(rows[0]!.secret_enc.toString('latin1')).not.toContain(body.secret);

      // O segredo devolvido assina tokens que a IRIS aceita.
      const token = signOrgToken(
        { kid: body.kid, orgId: org, secret: body.secret },
        { userId: sfId('005'), jti: 'pedido-db-0001', iat: Math.floor(Date.now() / 1000) },
      );
      expect(await orgKeys.verify(token)).toMatchObject({ ok: true });

      // O último uso grava-se em segundo plano.
      const lastUsed = async () => {
        const res = await app!.inject({ method: 'GET', url: base(org), headers: READ });
        return res.json<{ keys: { lastUsedAt: string | null }[] }>().keys[0]?.lastUsedAt;
      };
      for (let i = 0; i < 20 && (await lastUsed()) == null; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await lastUsed()).toEqual(expect.any(String));

      const list = await app!.inject({ method: 'GET', url: base(org), headers: READ });
      expect(list.json()).toEqual({ keys: [expect.objectContaining({ kid: body.kid })] });

      // As métricas contam o token aceite (só contagens).
      const m = await app!.inject({ method: 'GET', url: '/v1/admin/metrics', headers: READ });
      expect(m.json<{ auth: { accepted: number } }>().auth.accepted).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(list.json())).not.toContain(body.secret);
    });

    it('no máximo duas chaves ativas; revogar liberta o lugar e invalida os tokens', async () => {
      const org = sfId('00D');
      const create = () => app!.inject({ method: 'POST', url: base(org), headers: WRITE });
      const first = (await create()).json<{ kid: string; secret: string }>();
      expect((await create()).statusCode).toBe(201);
      const third = await create();
      expect(third.statusCode).toBe(422);

      const del = await app!.inject({
        method: 'DELETE',
        url: `${base(org)}/${first.kid}`,
        headers: WRITE,
      });
      expect(del.statusCode).toBe(204);
      expect((await create()).statusCode).toBe(201);

      const token = signOrgToken(
        { kid: first.kid, orgId: org, secret: first.secret },
        { userId: sfId('005'), jti: 'pedido-db-0002', iat: Math.floor(Date.now() / 1000) },
      );
      expect(await orgKeys.verify(token)).toEqual({ ok: false, reason: 'unknown_key' });

      const again = await app!.inject({
        method: 'DELETE',
        url: `${base(org)}/${first.kid}`,
        headers: WRITE,
      });
      expect(again.statusCode).toBe(404);
      const list = await app!.inject({ method: 'GET', url: base(org), headers: READ });
      expect(list.json<{ keys: { status: string }[] }>().keys.map((k) => k.status)).toEqual([
        'active',
        'active',
        'revoked',
      ]);
    });

    it('etiqueta: opcional ao criar, alterável e removível', async () => {
      const org = sfId('00D');
      const created = await app!.inject({
        method: 'POST',
        url: base(org),
        headers: WRITE,
        payload: { label: 'Sandbox UAT' },
      });
      expect(created.statusCode).toBe(201);
      const { kid } = created.json<{ kid: string; label: string }>();
      expect(created.json()).toMatchObject({ label: 'Sandbox UAT' });

      const renamed = await app!.inject({
        method: 'PATCH',
        url: `${base(org)}/${kid}`,
        headers: WRITE,
        payload: { label: 'Produção' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ kid, label: 'Produção' });
      expect(JSON.stringify(renamed.json())).not.toContain('secret');

      const cleared = await app!.inject({
        method: 'PATCH',
        url: `${base(org)}/${kid}`,
        headers: WRITE,
        payload: { label: null },
      });
      expect(cleared.json()).toMatchObject({ label: null });

      // Sem corpo: sem etiqueta.
      const plain = await app!.inject({ method: 'POST', url: base(org), headers: WRITE });
      expect(plain.statusCode).toBe(201);
      expect(plain.json()).toMatchObject({ label: null });
    });

    it('etiqueta: recusa vazia, com espaços à volta ou longa; 404 noutra org', async () => {
      const org = sfId('00D');
      for (const label of ['', ' Produção', 'x'.repeat(101)]) {
        const res = await app!.inject({
          method: 'POST',
          url: base(org),
          headers: WRITE,
          payload: { label },
        });
        expect(res.statusCode).toBe(422);
      }
      const { kid } = (await app!.inject({ method: 'POST', url: base(org), headers: WRITE })).json<{
        kid: string;
      }>();
      const other = await app!.inject({
        method: 'PATCH',
        url: `${base(sfId('00D'))}/${kid}`,
        headers: WRITE,
        payload: { label: 'X' },
      });
      expect(other.statusCode).toBe(404);
    });

    it('criar e revogar exigem quem faz a alteração', async () => {
      const res = await app!.inject({ method: 'POST', url: base(sfId('00D')), headers: READ });
      expect(res.statusCode).toBe(422);
    });
  });
});
