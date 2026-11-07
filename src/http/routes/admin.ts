import { createHash, timingSafeEqual } from 'node:crypto';
import { Type, type TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  AdminError,
  createOrgMemory,
  deleteMemoriesOf,
  deleteMemory,
  updateOrgMemory,
} from '../../admin/commands.js';
import { getMemory, pageOfMemories, memorySummary, type MemoryRow } from '../../admin/queries.js';
import {
  createPromptVersion,
  listPromptVersions,
  listToolCatalog,
  resetToolConfig,
  saveToolConfig,
  setActivePromptVersion,
  type ToolCatalogRow,
} from '../../admin/tools.js';
import type { Metrics } from '../../engine/metrics.js';
import type { ModulesReport } from '../../admin/modules.js';
import { ERROR_CATALOG } from '../../admin/error-catalog.js';
import { buildPipeline } from '../../admin/pipeline.js';
import type { Traces } from '../../traces/traces.js';
import type { Topology } from '../../admin/topology.js';
import type { ModelInfo } from '../../adapters/openrouter-models.js';
import type { BreakerStatus } from '../../engine/breaker.js';
import type { Engine } from '../../engine/engine.js';
import { MEMORY_CHARS_CAP } from '../../engine/memory.js';
import {
  fallbackChain,
  noOverrides,
  resolveOverrides,
  type ToolOverrides,
} from '../../engine/store.js';
import type { ToolDefinition } from '../../engine/tool.js';
import {
  overrideIssues,
  SETTINGS_REFRESH_MS,
  type RuntimeSettings,
  type SettingIssue,
  type SettingView,
} from '../../settings/settings.js';
import { AppError, type ErrorDetail } from '../errors.js';

/** O que a página de estado mostra. Montado no arranque (ver src/server.ts). */
export type StatusReport = Record<string, unknown>;

export interface AdminRoutesOptions {
  secret: string;
  pool: Pool;
  /** Ferramentas implementadas e ativas neste servidor. */
  tools: ToolDefinition[];
  /** As definições alteráveis sem reiniciar (ver src/settings/settings.ts). */
  settings: {
    current(): RuntimeSettings;
    describe(): SettingView[];
    validate(changes: Record<string, unknown>): SettingIssue[];
    update(changes: Record<string, unknown>, actor: string): Promise<void>;
  };
  /** O disjuntor do motor; sem motor não há o que mostrar nem fechar. */
  breakers: { status(): BreakerStatus[]; reset(model?: string): string[] } | undefined;
  /** Identifica esta instância: o disjuntor e as métricas são por instância. */
  instanceId: string;
  /** Os últimos pedidos (só metadados, em memória). Sem eles, `/traces` devolve uma lista vazia. */
  traces?: Traces | undefined;
  metrics: Metrics;
  status: () => Promise<StatusReport>;
  /** Os módulos e o estado de cada um (ver src/admin/topology-source.ts). */
  topology: () => Promise<Topology>;
  /** Os adaptadores descritos: o que fazem e que definições têm (ver src/admin/modules.ts). */
  modules: () => Promise<ModulesReport>;
  models: { list(): Promise<{ models: ModelInfo[]; fetchedAt: string }> };
  /** Sem dependências não há playground (falta base de dados ou OpenRouter). */
  playground:
    | {
        engine: Engine;
        /** `false` sem StepAccess configurado: não se pode pedir para contar utilização. */
        countsUsage: boolean;
      }
    | undefined;
}

// ---------- autenticação e erros ----------

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const secretMatches = (given: string, expected: string): boolean =>
  timingSafeEqual(sha256(given), sha256(expected));

/** Converte erros dos comandos de administração no formato de erro da API. */
function toApiError(err: unknown): unknown {
  if (!(err instanceof AdminError)) return err;
  switch (err.kind) {
    case 'not_found':
      return new AppError('not_found', 404, err.message);
    case 'invalid':
      return new AppError('invalid_request', 422, err.message);
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

const ACTOR_HEADER = 'x-admin-actor';

function actorOf(request: FastifyRequest): string | undefined {
  const value = request.headers[ACTOR_HEADER];
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200
    ? value.trim()
    : undefined;
}

// ---------- esquemas partilhados ----------

const OrgId = Type.String({ pattern: '^00D[A-Za-z0-9]{15}$' });
const UserId = Type.String({ pattern: '^005[A-Za-z0-9]{15}$' });
const MemoryId = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const ToolName = Type.String({ pattern: '^[a-z_]+$', maxLength: 64 });
const ToolCodes = Type.Array(ToolName, { maxItems: 20, uniqueItems: true });
// O limite em vigor (`memoryMaxChars`) é verificado pelas memórias; aqui só o máximo absoluto.
const MemoryContent = Type.String({ minLength: 1, maxLength: MEMORY_CHARS_CAP });

const PlaygroundBody = Type.Object(
  {
    orgId: OrgId,
    userId: UserId,
    input: Type.Record(Type.String(), Type.Unknown()),
    systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    fallbackModelsOverride: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 3 }),
    ),
  },
  { additionalProperties: false },
);

// ---------- formatos de resposta ----------

const memoryJson = (m: MemoryRow) => ({
  id: m.memoryId,
  scope: m.scope,
  source: m.source,
  orgId: m.sfOrgRef,
  userId: m.sfUserRef,
  content: m.content,
  tools: m.tools,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/**
 * API de administração da IRIS, para o backend do StepAccess. Tudo em `/v1/admin`, com
 * `Authorization: Bearer <ADMIN_API_SECRET>`. As escritas exigem `X-Admin-Actor` (quem fez).
 * Documentação completa: docs/ADMIN_API.md.
 */
export const adminRoutes: FastifyPluginAsyncTypebox<AdminRoutesOptions> = async (app, opts) => {
  const registered = new Map(opts.tools.map((t) => [t.name, t]));

  app.addHook('onRequest', async (request) => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    if (match?.[1] === undefined || !secretMatches(match[1], opts.secret)) {
      throw new AppError('unauthorized', 401, 'Credenciais inválidas.', [], {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (request.method !== 'GET' && actorOf(request) === undefined) {
      throw new AppError('invalid_request', 422, 'Falta indicar quem faz a alteração.', [
        {
          path: `headers.${ACTOR_HEADER}`,
          issue: 'obrigatório nas alterações (1 a 200 caracteres)',
        },
      ]);
    }
  });

  // Registo das alterações: quem, o quê, resultado. Nunca o conteúdo.
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET') return;
    request.log.info(
      {
        actor: actorOf(request),
        action: `${request.method} ${request.routeOptions.url ?? request.url}`,
        params: request.params,
        status: reply.statusCode,
      },
      'admin action',
    );
  });

  // ---------- estado, métricas e modelos ----------

  app.get('/v1/admin/status', async () => opts.status());

  app.get('/v1/admin/metrics', async () => opts.metrics.snapshot());

  // Os módulos da IRIS, como estão ligados e o estado de cada um, para a consola desenhar.
  app.get('/v1/admin/topology', async () => opts.topology());

  // Cada adaptador (PgEngineStore, PgMemoryStore, StepAccessClient, StepAccessUsageReporter,
  // OpenRouterProvider) com a descrição, as definições em vigor e o que falta controlar.
  app.get('/v1/admin/modules', async () => opts.modules());

  app.get(
    '/v1/admin/models',
    {
      schema: {
        // A query string chega sempre como texto (a validação não converte tipos).
        querystring: Type.Object(
          {
            structuredOnly: Type.Optional(
              Type.Union([Type.Literal('true'), Type.Literal('false')]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const { models, fetchedAt } = await opts.models.list();
      const structuredOnly = request.query.structuredOnly !== 'false';
      return {
        fetchedAt,
        models: structuredOnly ? models.filter((m) => m.supportsStructuredOutput) : models,
      };
    },
  );

  // ---------- definições ----------

  const settingsJson = () => ({
    refreshSeconds: SETTINGS_REFRESH_MS / 1000,
    settings: opts.settings.describe(),
  });

  app.get('/v1/admin/settings', async () => settingsJson());

  // Altera só as definições enviadas; `null` volta ao valor do `.env` (ou do código).
  app.patch(
    '/v1/admin/settings',
    {
      schema: {
        body: Type.Record(Type.String({ maxLength: 64 }), Type.Unknown(), { minProperties: 1 }),
      },
    },
    async (request) => {
      const body = request.body;
      const invalid = (details: ErrorDetail[]): AppError =>
        new AppError('invalid_request', 422, 'As definições não são válidas.', details);
      const issues = opts.settings.validate(body);
      if (issues.length > 0) {
        throw invalid(issues.map((i) => ({ path: `body.${i.key}`, issue: i.issue })));
      }
      // Os modelos novos têm de existir no OpenRouter: um modelo por omissão errado partia
      // todas as ferramentas sem configuração.
      const models = [
        ...(typeof body['defaultModel'] === 'string'
          ? [{ path: 'body.defaultModel', code: body['defaultModel'] }]
          : []),
        ...(Array.isArray(body['fallbackModels'])
          ? (body['fallbackModels'] as string[]).map((code, i) => ({
              path: `body.fallbackModels.${String(i)}`,
              code,
            }))
          : []),
      ];
      const unknown = await catalogIssues(models);
      if (unknown.length > 0) throw invalid(unknown);
      await opts.settings.update(body, actorOf(request) ?? '');
      return settingsJson();
    },
  );

  // Os códigos estáveis de cada saída do caminho de um pedido, com o passo e o estado HTTP.
  app.get('/v1/admin/errors', async () => ({ errors: ERROR_CATALOG }));

  // O disjuntor de cada modelo chamado desde o arranque, nesta instância.
  app.get('/v1/admin/breakers', async () => ({
    instanceId: opts.instanceId,
    breakers: opts.breakers?.status() ?? [],
  }));

  // Fecha o disjuntor de um modelo (`?model=…`) ou de todos, sem esperar que o tempo aberto
  // acabe. Sem corpo: os códigos dos modelos têm barras, por isso vão na query string.
  app.post(
    '/v1/admin/breakers/reset',
    {
      schema: {
        querystring: Type.Object(
          { model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      if (opts.breakers === undefined) {
        throw new AppError('service_unavailable', 503, 'O motor não está ligado.');
      }
      return { closed: opts.breakers.reset(request.query.model) };
    },
  );

  // ---------- ferramentas ----------

  const toolJson = (row: ToolCatalogRow) => {
    const code = registered.get(row.name);
    const engine = opts.settings.current();
    const defaults =
      code === undefined ? null : { model: engine.defaultModel, ...code.defaults, enabled: true };
    return {
      name: row.name,
      implemented: code !== undefined,
      version: code?.version ?? null,
      description: code?.description ?? null,
      enabled: row.config?.enabled ?? true,
      config:
        row.config !== null
          ? {
              model: row.config.model,
              temperature: row.config.temperature,
              maxOutputTokens: row.config.maxOutputTokens,
              timeoutMs: row.config.timeoutMs,
              fallbackModels: row.config.fallbackModels,
              overrides: resolveOverrides(row.config.overrides, engine),
              source: 'database' as const,
            }
          : defaults === null
            ? null
            : {
                model: defaults.model,
                temperature: defaults.temperature,
                maxOutputTokens: defaults.maxOutputTokens,
                timeoutMs: defaults.timeoutMs,
                fallbackModels: fallbackChain(defaults.model, engine.fallbackModels),
                overrides: resolveOverrides(noOverrides(), engine),
                source: 'default' as const,
              },
      prompt: {
        source:
          row.activePromptVersion !== null
            ? ('database' as const)
            : code !== undefined
              ? ('code' as const)
              : ('none' as const),
        activeVersion: row.activePromptVersion,
        versionCount: row.promptVersionCount,
      },
    };
  };

  /** Cada modelo tem de existir no catálogo do OpenRouter e suportar respostas com JSON Schema. */
  async function catalogIssues(entries: { path: string; code: string }[]): Promise<ErrorDetail[]> {
    if (entries.length === 0) return [];
    const { models } = await opts.models.list();
    const known = new Map(models.map((m) => [m.id, m]));
    return entries.flatMap(({ path, code }) => {
      const info = known.get(code);
      if (info === undefined)
        return [{ path, issue: 'não existe no catálogo de modelos do OpenRouter' }];
      if (!info.supportsStructuredOutput)
        return [{ path, issue: 'não suporta respostas com JSON Schema' }];
      return [];
    });
  }

  /** Os modelos de recurso: sem repetidos, nenhum igual ao principal, e todos no catálogo. */
  async function checkFallbackModels(model: string, fallbackModels: string[]): Promise<void> {
    const details: ErrorDetail[] = [];
    const toCheck: { path: string; code: string }[] = [];
    fallbackModels.forEach((code, i) => {
      const path = `body.fallbackModels.${String(i)}`;
      if (code === model) details.push({ path, issue: 'é o modelo principal' });
      else if (fallbackModels.indexOf(code) !== i) details.push({ path, issue: 'repetido' });
      else toCheck.push({ path, code });
    });
    details.push(...(await catalogIssues(toCheck)));
    if (details.length > 0) {
      throw new AppError('invalid_request', 422, 'Os modelos de recurso não são válidos.', details);
    }
  }

  async function catalogRow(name: string): Promise<ToolCatalogRow> {
    const [row] = await listToolCatalog(opts.pool, name);
    if (row === undefined) throw new AppError('unknown_tool', 404, 'Ferramenta desconhecida.');
    return row;
  }

  async function toolDetail(name: string) {
    const row = await catalogRow(name);
    const code = registered.get(name);
    const engine = opts.settings.current();
    return {
      ...toolJson(row),
      defaults:
        code === undefined
          ? null
          : {
              model: engine.defaultModel,
              fallbackModels: fallbackChain(engine.defaultModel, engine.fallbackModels),
              ...code.defaults,
            },
      codePrompt: code?.systemPrompt ?? null,
      inputSchema: code === undefined ? null : (JSON.parse(JSON.stringify(code.input)) as unknown),
      outputSchema:
        code === undefined ? null : (JSON.parse(JSON.stringify(code.output)) as unknown),
    };
  }

  const NameParams = Type.Object({ name: ToolName });

  app.get('/v1/admin/tools', async () => ({
    tools: (await listToolCatalog(opts.pool)).map(toolJson),
  }));

  app.get('/v1/admin/tools/:name', { schema: { params: NameParams } }, async (request) =>
    toolDetail(request.params.name),
  );

  // O caminho de um pedido a esta ferramenta, passo a passo, para o diagrama da consola.
  app.get('/v1/admin/tools/:name/pipeline', { schema: { params: NameParams } }, async (request) => {
    const { name } = request.params;
    const row = await catalogRow(name);
    const code = registered.get(name);
    const engine = opts.settings.current();
    const model = row.config?.model ?? (code === undefined ? null : engine.defaultModel);
    const topology = await opts.topology();
    return buildPipeline({
      tool: name,
      implemented: code !== undefined,
      enabled: row.config?.enabled ?? true,
      streamSupported: code?.stream !== undefined,
      model,
      fallbackModels:
        model === null
          ? []
          : (row.config?.fallbackModels ?? fallbackChain(model, engine.fallbackModels)),
      prompt: {
        source:
          row.activePromptVersion !== null ? 'database' : code !== undefined ? 'code' : 'none',
        activeVersion: row.activePromptVersion,
      },
      overrides: resolveOverrides(row.config?.overrides, engine),
      since: opts.metrics.since,
      metrics: opts.metrics.pipeline(name),
      breakers: opts.breakers?.status() ?? [],
      topology,
    });
  });

  // Os últimos pedidos a esta ferramenta, só metadados (sem texto nem utilizador).
  app.get(
    '/v1/admin/tools/:name/traces',
    {
      schema: {
        params: NameParams,
        querystring: Type.Object(
          // A query string chega sempre como texto.
          {
            limit: Type.Optional(
              Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$' }),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const { name } = request.params;
      await catalogRow(name);
      const limit = Number(request.query.limit ?? '20');
      return {
        tool: name,
        instanceId: opts.instanceId,
        enabled: opts.traces !== undefined && opts.settings.current().tracesEnabled,
        traces: opts.traces?.list(name, limit) ?? [],
      };
    },
  );

  // Simulação a seco: os passos de entrada e de contexto, sem StepAccess nem modelo (sem custo).
  app.post(
    '/v1/admin/tools/:name/dry-run',
    {
      schema: {
        params: NameParams,
        body: Type.Object(
          { orgId: OrgId, userId: UserId, input: Type.Record(Type.String(), Type.Unknown()) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const tool = playgroundTool(request.params.name);
      const deps = playgroundDeps();
      const { orgId, userId, input } = request.body;
      checkInput(tool, input);
      const prepared = await deps.engine.preview(tool.name, { orgId, userId, input });
      const t = prepared.timings;
      const chars = prepared.system.length + prepared.user.length;
      return {
        tool: tool.name,
        path: [
          { stage: 'request', ms: 0 },
          { stage: 'gate', ms: t.gate },
          { stage: 'rate', ms: 0, skipped: true },
          { stage: 'access', ms: 0, skipped: true },
          { stage: 'memories', ms: t.memories },
          { stage: 'prompt', ms: t.prompt },
        ],
        prompt: {
          systemChars: prepared.system.length,
          userChars: prepared.user.length,
          // Estimativa grosseira (~4 caracteres por token); o valor real só o modelo o dá.
          estimatedTokens: Math.ceil(chars / 4),
        },
        memories: { org: prepared.memories.org.length, user: prepared.memories.user.length },
        model: prepared.settings.model,
        fallbackModels: prepared.settings.fallbackModels,
        enabled: prepared.settings.enabled,
      };
    },
  );

  app.put(
    '/v1/admin/tools/:name/config',
    {
      schema: {
        params: NameParams,
        body: Type.Object(
          {
            model: Type.String({ minLength: 1, maxLength: 200 }),
            temperature: Type.Number({ minimum: 0, maximum: 2 }),
            maxOutputTokens: Type.Integer({ minimum: 1, maximum: 32_000 }),
            timeoutMs: Type.Integer({ minimum: 1000, maximum: 120_000 }),
            enabled: Type.Boolean(),
            fallbackModels: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 3 }),
            ),
            // Substituições das definições globais: validadas abaixo com as mesmas regras (e
            // mensagens) de PATCH /v1/admin/settings. `null` ou ausente: segue a global.
            maxAttempts: Type.Optional(Type.Unknown()),
            totalTimeoutMs: Type.Optional(Type.Unknown()),
            rateLimitPerMinute: Type.Optional(Type.Unknown()),
            streamEnabled: Type.Optional(Type.Unknown()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      await catalogRow(request.params.name);
      const { maxAttempts, totalTimeoutMs, rateLimitPerMinute, streamEnabled, ...config } =
        request.body;
      const raw = { maxAttempts, totalTimeoutMs, rateLimitPerMinute, streamEnabled };
      const issues = overrideIssues(raw);
      if (issues.length > 0) {
        throw new AppError(
          'invalid_request',
          422,
          'As definições não são válidas.',
          issues.map((i) => ({ path: `body.${i.key}`, issue: i.issue })),
        );
      }
      // Validadas acima: só ficam valores dentro dos limites ou `null`.
      const overrides = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, v ?? null]),
      ) as unknown as ToolOverrides;
      const fallbackModels = config.fallbackModels ?? [];
      await checkFallbackModels(config.model, fallbackModels);
      await guard(() =>
        saveToolConfig(opts.pool, request.params.name, { ...config, fallbackModels, overrides }),
      );
      return toolDetail(request.params.name);
    },
  );

  app.delete(
    '/v1/admin/tools/:name/config',
    { schema: { params: NameParams } },
    async (request) => {
      await catalogRow(request.params.name);
      await guard(() => resetToolConfig(opts.pool, request.params.name));
      return toolDetail(request.params.name);
    },
  );

  // ---------- prompts ----------

  app.get(
    '/v1/admin/tools/:name/prompt-versions',
    { schema: { params: NameParams } },
    async (request) => {
      const row = await catalogRow(request.params.name);
      const versions = await guard(() => listPromptVersions(opts.pool, request.params.name));
      return {
        tool: row.name,
        activeVersion: row.activePromptVersion,
        codePrompt: registered.get(row.name)?.systemPrompt ?? null,
        versions,
      };
    },
  );

  app.post(
    '/v1/admin/tools/:name/prompt-versions',
    {
      schema: {
        params: NameParams,
        body: Type.Object(
          {
            systemTemplate: Type.String({ minLength: 1, maxLength: 20_000 }),
            changeNote: Type.Optional(Type.String({ maxLength: 500 })),
            activate: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      await catalogRow(request.params.name);
      const { systemTemplate, changeNote, activate } = request.body;
      const created = await guard(() =>
        createPromptVersion(opts.pool, request.params.name, {
          systemTemplate,
          ...(changeNote !== undefined && { changeNote }),
          activate: activate === true,
        }),
      );
      const versions = await listPromptVersions(opts.pool, request.params.name);
      return reply.status(201).send(versions.find((v) => v.version === created.version));
    },
  );

  app.put(
    '/v1/admin/tools/:name/active-prompt',
    {
      schema: {
        params: NameParams,
        body: Type.Object(
          { version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      await catalogRow(request.params.name);
      await guard(() =>
        setActivePromptVersion(opts.pool, request.params.name, request.body.version),
      );
      return { tool: request.params.name, activeVersion: request.body.version };
    },
  );

  // ---------- memórias ----------

  app.get(
    '/v1/admin/memories',
    {
      schema: {
        querystring: Type.Object(
          {
            orgId: Type.Optional(OrgId),
            userId: Type.Optional(UserId),
            scope: Type.Optional(Type.Union([Type.Literal('org'), Type.Literal('user')])),
            tool: Type.Optional(ToolName),
            search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            // Números em texto: a validação não converte tipos na query string.
            limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' })),
            offset: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const q = request.query;
      const filter = {
        ...(q.orgId !== undefined && { sfOrgRef: q.orgId }),
        ...(q.userId !== undefined && { sfUserRef: q.userId }),
        ...(q.scope !== undefined && { scope: q.scope }),
        ...(q.tool !== undefined && { tool: q.tool }),
        ...(q.search !== undefined && { search: q.search }),
      };
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      const offset = q.offset === undefined ? 0 : Number(q.offset);
      const { items, total } = await pageOfMemories(opts.pool, filter, { limit, offset });
      return { items: items.map(memoryJson), total, limit, offset };
    },
  );

  app.get(
    '/v1/admin/memories/summary',
    { schema: { querystring: Type.Object({ orgId: OrgId }, { additionalProperties: false }) } },
    async (request) => {
      const s = await memorySummary(opts.pool, request.query.orgId);
      return {
        orgId: s.sfOrgRef,
        org: s.org,
        users: s.users.map((u) => ({ userId: u.sfUserRef, count: u.count, limit: u.limit })),
      };
    },
  );

  const MemoryParams = Type.Object({ memoryId: MemoryId });

  async function memoryOr404(id: string): Promise<MemoryRow> {
    const m = await getMemory(opts.pool, id);
    if (m === undefined) throw new AppError('not_found', 404, 'A memória não existe.');
    return m;
  }

  app.get('/v1/admin/memories/:memoryId', { schema: { params: MemoryParams } }, async (request) =>
    memoryJson(await memoryOr404(request.params.memoryId)),
  );

  app.post(
    '/v1/admin/memories',
    {
      schema: {
        body: Type.Object(
          { orgId: OrgId, content: MemoryContent, tools: Type.Optional(ToolCodes) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { memoryId } = await guard(() =>
        createOrgMemory(opts.pool, {
          sfOrgRef: request.body.orgId,
          content: request.body.content,
          tools: request.body.tools ?? [],
        }),
      );
      return reply.status(201).send(memoryJson(await memoryOr404(memoryId)));
    },
  );

  app.patch(
    '/v1/admin/memories/:memoryId',
    {
      schema: {
        params: MemoryParams,
        body: Type.Object(
          { content: Type.Optional(MemoryContent), tools: Type.Optional(ToolCodes) },
          { additionalProperties: false, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      await guard(() =>
        updateOrgMemory(opts.pool, {
          memoryId: request.params.memoryId,
          ...(request.body.content !== undefined && { content: request.body.content }),
          ...(request.body.tools !== undefined && { tools: request.body.tools }),
        }),
      );
      return memoryJson(await memoryOr404(request.params.memoryId));
    },
  );

  app.delete(
    '/v1/admin/memories/:memoryId',
    { schema: { params: MemoryParams } },
    async (request, reply) => {
      await guard(() => deleteMemory(opts.pool, { memoryId: request.params.memoryId }));
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/admin/memories/purge',
    {
      schema: {
        body: Type.Object(
          { orgId: OrgId, userId: Type.Optional(UserId) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const deleted = await guard(() =>
        deleteMemoriesOf(opts.pool, {
          sfOrgRef: request.body.orgId,
          ...(request.body.userId !== undefined && { sfUserRef: request.body.userId }),
        }),
      );
      return { deleted };
    },
  );

  // ---------- playground ----------

  function playgroundTool(name: string): ToolDefinition {
    const tool = registered.get(name);
    if (tool === undefined) {
      throw new AppError(
        'unknown_tool',
        404,
        'Ferramenta desconhecida ou sem implementação neste servidor.',
      );
    }
    return tool;
  }

  /** Valida a entrada contra o contrato da ferramenta, com os mesmos erros da API pública. */
  function checkInput(tool: ToolDefinition, input: Record<string, unknown>): void {
    const schema: TObject = Type.Object(tool.input.properties, { additionalProperties: false });
    const details: ErrorDetail[] = [...Value.Errors(schema, input)].map((e) => ({
      path: ['body', 'input', ...e.path.split('/').filter(Boolean)].join('.'),
      issue: e.message,
    }));
    if (details.length > 0)
      throw new AppError('invalid_request', 422, 'O pedido não é válido.', details);
  }

  function playgroundDeps() {
    if (opts.playground === undefined) {
      throw new AppError(
        'service_unavailable',
        503,
        'O playground precisa da base de dados e do OpenRouter configurados.',
      );
    }
    return opts.playground;
  }

  app.post(
    '/v1/admin/playground/:name/preview',
    { schema: { params: NameParams, body: PlaygroundBody } },
    async (request) => {
      const tool = playgroundTool(request.params.name);
      const deps = playgroundDeps();
      const { orgId, userId, input, systemPrompt, model, fallbackModelsOverride } = request.body;
      checkInput(tool, input);
      const prepared = await deps.engine.preview(
        tool.name,
        { orgId, userId, input },
        {
          ...(systemPrompt !== undefined && { systemPrompt }),
          ...(model !== undefined && { model }),
          ...(fallbackModelsOverride !== undefined && { fallbackModels: fallbackModelsOverride }),
        },
      );
      return {
        tool: tool.name,
        settings: prepared.settings,
        memories: prepared.memories,
        prompt: { system: prepared.system, user: prepared.user },
        outputSchema: prepared.schema,
      };
    },
  );

  app.post(
    '/v1/admin/playground/:name/run',
    {
      schema: {
        params: NameParams,
        body: Type.Object(
          {
            ...PlaygroundBody.properties,
            countUsage: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const tool = playgroundTool(request.params.name);
      const deps = playgroundDeps();
      const { orgId, userId, input, systemPrompt, model, countUsage, fallbackModelsOverride } =
        request.body;
      checkInput(tool, input);
      if (countUsage === true && !deps.countsUsage) {
        throw new AppError(
          'service_unavailable',
          503,
          'Não é possível contar utilização: o StepAccess não está configurado.',
        );
      }

      const started = performance.now();
      const { prepared, result, attempts, error, timings } = await deps.engine.trial(
        tool.name,
        { orgId, userId, input },
        {
          checkAccess: countUsage === true,
          ...(systemPrompt !== undefined && { systemPrompt }),
          ...(model !== undefined && { model }),
          ...(fallbackModelsOverride !== undefined && { fallbackModels: fallbackModelsOverride }),
        },
      );
      return {
        tool: tool.name,
        ok: result !== undefined,
        result: result ?? null,
        // Quando toda a cadeia falhou: o código e a mensagem do último erro (nunca do fornecedor).
        error:
          error === undefined || result !== undefined
            ? null
            : { code: error.code, message: error.message },
        countedUsage: countUsage === true,
        durationMs: Math.round(performance.now() - started),
        // Tempo real de cada passo, para a consola animar a simulação (`access` é 0 sem contar).
        timings,
        settings: prepared.settings,
        memories: prepared.memories,
        prompt: { system: prepared.system, user: prepared.user },
        attempts,
      };
    },
  );
};
