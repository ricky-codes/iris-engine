import { createHash, timingSafeEqual } from 'node:crypto';
import { Type, type TObject } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type { Metrics } from '../../engine/metrics.js';
import { runTool, type EngineDeps } from '../../engine/run.js';
import type { ToolDefinition } from '../../engine/tool.js';
import { errorCodeOf } from '../error-handler.js';
import { AppError } from '../errors.js';

export interface ToolRoutesOptions {
  tools: ToolDefinition[];
  deps: EngineDeps;
  apiSecret: string;
  /** Contadores agregados (sem conteúdo) para a API de administração. */
  metrics?: Metrics;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compara em tempo constante (os hashes têm sempre o mesmo tamanho). */
function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

export const unauthorized = (): AppError =>
  new AppError('unauthorized', 401, 'Credenciais inválidas.', [], {
    'WWW-Authenticate': 'Bearer',
  });

/** Exige `Authorization: Bearer <segredo>`. Corre antes de se ler o corpo. */
export function bearerAuth(secret: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    if (match?.[1] === undefined || !secretMatches(match[1], secret)) throw unauthorized();
  };
}

/** Campos comuns a todos os pedidos. Os ids vêm do Salesforce, sempre com 18 caracteres. */
const Envelope = {
  orgId: Type.String({ pattern: '^00D[A-Za-z0-9]{15}$' }),
  userId: Type.String({ pattern: '^005[A-Za-z0-9]{15}$' }),
};

function bodySchema(tool: ToolDefinition): TObject {
  return Type.Object(
    {
      ...Envelope,
      version: Type.Optional(Type.Literal(tool.version)),
      ...tool.input.properties,
    },
    { additionalProperties: false },
  );
}

/**
 * `POST /v1/tools/<nome>` para cada ferramenta e `GET /v1/tools` para as listar.
 * A autenticação corre antes da validação do corpo: sem credencial não se revela nada.
 */
export const toolRoutes: FastifyPluginAsyncTypebox<ToolRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', bearerAuth(opts.apiSecret));

  // Tokens de cada pedido, para as métricas. Somem com o pedido.
  const usage = new WeakMap<FastifyRequest, { inputTokens?: number; outputTokens?: number }>();
  const toolNames = new Set(opts.tools.map((t) => t.name));

  app.addHook('onResponse', async (request, reply) => {
    if (opts.metrics === undefined || request.method !== 'POST') return;
    const name = request.routeOptions.url?.replace(/^\/v1\/tools\//, '');
    if (name === undefined || !toolNames.has(name)) return;
    const tokens = usage.get(request);
    opts.metrics.record({
      tool: name,
      errorCode: reply.statusCode < 400 ? undefined : (errorCodeOf(request) ?? 'internal_error'),
      durationMs: reply.elapsedTime,
      inputTokens: tokens?.inputTokens,
      outputTokens: tokens?.outputTokens,
    });
  });

  app.get('/v1/tools', async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
    })),
  }));

  for (const tool of opts.tools) {
    app.post(`/v1/tools/${tool.name}`, { schema: { body: bodySchema(tool) } }, async (request) => {
      const body = request.body as Record<string, unknown> & { orgId: string; userId: string };
      const { orgId, userId } = body;
      // A entrada da ferramenta é o corpo sem os campos comuns.
      const input = Object.fromEntries(
        Object.entries(body).filter(([k]) => k !== 'orgId' && k !== 'userId' && k !== 'version'),
      );

      const started = performance.now();
      const { result, meta } = await runTool(opts.deps, tool, {
        orgId,
        userId,
        input,
        requestId: request.id,
      });
      usage.set(request, {
        ...(meta.inputTokens !== undefined && { inputTokens: meta.inputTokens }),
        ...(meta.outputTokens !== undefined && { outputTokens: meta.outputTokens }),
      });
      request.log.info(
        { tool: tool.name, ...meta, durationMs: Math.round(performance.now() - started) },
        'tool completed',
      );
      return { tool: tool.name, version: tool.version, result };
    });
  }

  app.post('/v1/tools/:name', async () => {
    throw new AppError('unknown_tool', 404, 'Ferramenta desconhecida.');
  });
};
