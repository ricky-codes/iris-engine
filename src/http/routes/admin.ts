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
import {
  countMemories,
  getMemory,
  listMemories,
  memorySummary,
  type MemoryRow,
} from '../../admin/queries.js';
import {
  createPromptVersion,
  listPromptVersions,
  listToolCatalog,
  resetToolConfig,
  saveToolConfig,
  setActivePromptVersion,
  type ToolCatalogRow,
} from '../../admin/tools.js';
import type { AccessChecker } from '../../engine/access.js';
import type { LlmProvider } from '../../engine/llm.js';
import type { Metrics } from '../../engine/metrics.js';
import type { ModelInfo } from '../../engine/models.js';
import { callModel, prepareRun } from '../../engine/run.js';
import type { EngineStore } from '../../engine/store.js';
import type { ToolDefinition } from '../../engine/tool.js';
import { AppError, type ErrorDetail } from '../errors.js';

/** O que a página de estado mostra. Montado no arranque (ver src/server.ts). */
export type StatusReport = Record<string, unknown>;

export interface AdminRoutesOptions {
  secret: string;
  pool: Pool;
  /** Ferramentas implementadas e ativas neste servidor. */
  tools: ToolDefinition[];
  defaultModel: string;
  metrics: Metrics;
  status: () => Promise<StatusReport>;
  models: { list(): Promise<{ models: ModelInfo[]; fetchedAt: string }> };
  /** Sem dependências não há playground (falta base de dados ou OpenRouter). */
  playground:
    | {
        store: EngineStore;
        llm: LlmProvider;
        /** Para contar utilização a pedido. Sem StepAccess configurado, `undefined`. */
        access: AccessChecker | undefined;
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
    case 'limit':
      return new AppError('memory_limit_reached', 409, err.message);
    case 'forbidden':
      return new AppError('forbidden', 403, err.message);
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
const MemoryContent = Type.String({ minLength: 1, maxLength: 500 });

const PlaygroundBody = Type.Object(
  {
    orgId: OrgId,
    userId: UserId,
    input: Type.Record(Type.String(), Type.Unknown()),
    systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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

  // ---------- ferramentas ----------

  const toolJson = (row: ToolCatalogRow) => {
    const code = registered.get(row.name);
    const defaults =
      code === undefined ? null : { model: opts.defaultModel, ...code.defaults, enabled: true };
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
              source: 'database' as const,
            }
          : defaults === null
            ? null
            : {
                model: defaults.model,
                temperature: defaults.temperature,
                maxOutputTokens: defaults.maxOutputTokens,
                timeoutMs: defaults.timeoutMs,
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

  async function catalogRow(name: string): Promise<ToolCatalogRow> {
    const row = (await listToolCatalog(opts.pool)).find((r) => r.name === name);
    if (row === undefined) throw new AppError('unknown_tool', 404, 'Ferramenta desconhecida.');
    return row;
  }

  async function toolDetail(name: string) {
    const row = await catalogRow(name);
    const code = registered.get(name);
    return {
      ...toolJson(row),
      defaults: code === undefined ? null : { model: opts.defaultModel, ...code.defaults },
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
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      await catalogRow(request.params.name);
      await guard(() => saveToolConfig(opts.pool, request.params.name, request.body));
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
      const [items, total] = await Promise.all([
        listMemories(opts.pool, filter, { limit, offset }),
        countMemories(opts.pool, filter),
      ]);
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
      const { orgId, userId, input, systemPrompt, model } = request.body;
      checkInput(tool, input);
      const prepared = await prepareRun(
        {
          access: deps.access ?? { check: async () => undefined },
          store: deps.store,
          defaultModel: opts.defaultModel,
        },
        tool,
        { orgId, userId, input },
        {
          checkAccess: false,
          requireEnabled: false,
          ...(systemPrompt !== undefined && { systemPromptOverride: systemPrompt }),
          ...(model !== undefined && { modelOverride: model }),
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
      const { orgId, userId, input, systemPrompt, model, countUsage } = request.body;
      checkInput(tool, input);
      if (countUsage === true && deps.access === undefined) {
        throw new AppError(
          'service_unavailable',
          503,
          'Não é possível contar utilização: o StepAccess não está configurado.',
        );
      }

      const started = performance.now();
      const prepared = await prepareRun(
        {
          access: deps.access ?? { check: async () => undefined },
          store: deps.store,
          defaultModel: opts.defaultModel,
        },
        tool,
        { orgId, userId, input },
        {
          checkAccess: countUsage === true,
          requireEnabled: false,
          ...(systemPrompt !== undefined && { systemPromptOverride: systemPrompt }),
          ...(model !== undefined && { modelOverride: model }),
        },
      );
      const { result, attempts } = await callModel(deps.llm, tool, prepared);
      return {
        tool: tool.name,
        ok: result !== undefined,
        result: result ?? null,
        countedUsage: countUsage === true,
        durationMs: Math.round(performance.now() - started),
        settings: prepared.settings,
        memories: prepared.memories,
        prompt: { system: prepared.system, user: prepared.user },
        attempts,
      };
    },
  );
};
