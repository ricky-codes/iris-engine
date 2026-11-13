import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { MEMORY_CHARS_CAP, type Memories, type Memory } from '../../engine/memory.js';
import { ownerOf, publicAuth, type PublicAuth } from '../auth.js';

/** `orgKeys` (tokens das orgs) ou `apiSecret` (segredo partilhado): ver src/http/auth.ts. */
export type MemoryRoutesOptions = PublicAuth & {
  memories: Memories;
};

// Os ids vêm do Salesforce, sempre com 18 caracteres.
const OrgId = Type.String({ pattern: '^00D[A-Za-z0-9]{15}$' });
const UserId = Type.String({ pattern: '^005[A-Za-z0-9]{15}$' });
const MemoryId = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const ToolName = Type.String({ pattern: '^[a-z_]+$', maxLength: 64 });
const Owner = { orgId: OrgId, userId: UserId };

const memoryJson = (m: Memory) => ({
  id: m.id,
  scope: m.scope,
  content: m.content,
  tools: m.tools,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/**
 * As memórias de cada utilizador, geridas a partir do Salesforce com o mesmo
 * token da org (ou o segredo partilhado) das ferramentas. Não passam pelo StepAccess:
 * gerir memórias não conta utilização.
 *
 * O utilizador vê as regras da org (só leitura) e as suas memórias; cria e apaga só as suas.
 */
export const memoryRoutes: FastifyPluginAsyncTypebox<MemoryRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', publicAuth(opts));
  // Com tokens, os ids vêm do token e não podem vir no pedido (campos a mais dão 422). O tipo
  // mente nesse caso: os ids lêem-se sempre por `ownerOf`, que trata dos dois modos.
  const owner = (opts.orgKeys === undefined ? Owner : {}) as typeof Owner;

  app.get(
    '/v1/memories',
    {
      schema: {
        querystring: Type.Object(
          { ...owner, tool: Type.Optional(ToolName) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const { tool } = request.query;
      const { orgId, userId } = ownerOf(request, request.query);
      const byTool = tool === undefined ? {} : { tool };
      const [org, user] = await Promise.all([
        opts.memories.list({ orgId, scope: 'org', ...byTool }),
        opts.memories.list({ orgId, userId, scope: 'user', ...byTool }),
      ]);
      const mine = tool === undefined ? user.total : await opts.memories.count({ orgId, userId });
      return {
        org: org.items.map(memoryJson),
        user: user.items.map(memoryJson),
        limits: { user: { count: mine, limit: opts.memories.limits().perUser } },
      };
    },
  );

  app.post(
    '/v1/memories',
    {
      schema: {
        body: Type.Object(
          {
            ...owner,
            // O limite em vigor (`memoryMaxChars`) é verificado pelas memórias; aqui só o máximo absoluto.
            content: Type.String({ minLength: 1, maxLength: MEMORY_CHARS_CAP }),
            tools: Type.Optional(Type.Array(ToolName, { maxItems: 20, uniqueItems: true })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { content, tools } = request.body;
      const { orgId, userId } = ownerOf(request, request.body);
      const m = await opts.memories.remember({
        owner: { orgId, userId },
        source: 'user',
        content,
        tools: tools ?? [],
      });
      request.log.info({ memoryId: m.id }, 'memory created');
      return reply.status(201).send(memoryJson(m));
    },
  );

  app.delete(
    '/v1/memories/:memoryId',
    {
      schema: {
        params: Type.Object({ memoryId: MemoryId }),
        querystring: Type.Object(owner, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = ownerOf(request, request.query);
      await opts.memories.forget(request.params.memoryId, { orgId, userId });
      request.log.info({ memoryId: request.params.memoryId }, 'memory deleted');
      return reply.status(204).send();
    },
  );
};
