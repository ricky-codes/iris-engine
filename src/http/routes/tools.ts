import { createHash, timingSafeEqual } from 'node:crypto';
import { Type, type TObject } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyError, FastifyRequest } from 'fastify';
import type { Metrics } from '../../engine/metrics.js';
import type { Engine } from '../../engine/engine.js';
import type { ToolDefinition } from '../../engine/tool.js';
import type { PipelineStage } from '../../engine/pipeline.js';
import { errorCodeOf, errorStageOf, resolveError } from '../error-handler.js';
import { AppError, type ErrorBody } from '../errors.js';

export interface ToolRoutesOptions {
  engine: Engine;
  apiSecret: string;
  /** Contadores agregados (sem conteúdo) para a API de administração. */
  metrics?: Metrics;
}

/** Os erros anteriores ao motor (credencial, corpo) param no primeiro passo. */
const REQUEST_CODES = new Set([
  'unauthorized',
  'invalid_request',
  'payload_too_large',
  'unsupported_media_type',
]);

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
      // Resposta em streaming (SSE). Só as ferramentas com `stream` a aceitam.
      stream: Type.Optional(Type.Boolean()),
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
  const usage = new WeakMap<
    FastifyRequest,
    { inputTokens?: number; outputTokens?: number; fallback?: boolean }
  >();
  const toolNames = new Set(opts.engine.tools().map((t) => t.name));

  // Pedidos em streaming registam as métricas ao terminar a ligação, não no `onResponse`.
  const recorded = new WeakSet<FastifyRequest>();
  const record = (
    request: FastifyRequest,
    tool: string,
    errorCode: string | undefined,
    durationMs: number,
  ): void => {
    if (opts.metrics === undefined || recorded.has(request)) return;
    recorded.add(request);
    const tokens = usage.get(request);
    const stage: PipelineStage | undefined =
      errorCode === undefined
        ? undefined
        : (errorStageOf(request) ?? (REQUEST_CODES.has(errorCode) ? 'request' : 'response'));
    opts.metrics.record({
      tool,
      errorCode,
      stage,
      durationMs,
      inputTokens: tokens?.inputTokens,
      outputTokens: tokens?.outputTokens,
      fallback: tokens?.fallback,
    });
  };

  app.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'POST') return;
    const name = request.routeOptions.url?.replace(/^\/v1\/tools\//, '');
    if (name === undefined || !toolNames.has(name)) return;
    record(
      request,
      name,
      reply.statusCode < 400 ? undefined : (errorCodeOf(request) ?? 'internal_error'),
      reply.elapsedTime,
    );
  });

  app.get('/v1/tools', async () => {
    const streaming = await opts.engine.streaming();
    return {
      tools: opts.engine.tools().map((t) => ({
        name: t.name,
        version: t.version,
        description: t.description,
        streaming: streaming.get(t.name) ?? false,
      })),
    };
  });

  for (const tool of opts.engine.tools()) {
    app.post(
      `/v1/tools/${tool.name}`,
      { schema: { body: bodySchema(tool) } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown> & {
          orgId: string;
          userId: string;
          stream?: boolean;
        };
        const { orgId, userId } = body;
        // A entrada da ferramenta é o corpo sem os campos comuns.
        const input = Object.fromEntries(
          Object.entries(body).filter(
            ([k]) => k !== 'orgId' && k !== 'userId' && k !== 'version' && k !== 'stream',
          ),
        );

        // O limite de pedidos e o streaming dependem da ferramenta: o motor verifica-os logo a
        // seguir a ler a configuração, antes do StepAccess e do modelo.
        const started = performance.now();

        if (body.stream === true) {
          // Os erros anteriores à chamada ao modelo (credencial, validação, acesso, ferramenta
          // desligada) saem como JSON normal. A partir daí a resposta é SSE e os erros vão num
          // evento `error`, porque o estado HTTP já seguiu.
          const raw = reply.raw;
          const state = { opened: false };
          const send = (event: string, data: unknown): void => {
            if (raw.destroyed || raw.writableEnded) return;
            raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          const open = (): void => {
            if (state.opened) return;
            state.opened = true;
            reply.hijack();
            raw.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              // Sem isto, um proxy nginx guarda a resposta e o cliente só a vê no fim.
              'X-Accel-Buffering': 'no',
              'X-Request-Id': request.id,
            });
            send('start', { tool: tool.name, version: tool.version, requestId: request.id });
          };
          try {
            const { result, meta } = await opts.engine.run(tool.name, {
              orgId,
              userId,
              input,
              requestId: request.id,
              stream: {
                onStart: open,
                onDelta: (text) => {
                  send('delta', { text });
                },
                onReset: () => {
                  send('reset', {});
                },
              },
            });
            open();
            usage.set(request, {
              ...(meta.inputTokens !== undefined && { inputTokens: meta.inputTokens }),
              ...(meta.outputTokens !== undefined && { outputTokens: meta.outputTokens }),
              fallback: meta.fallback,
            });
            send('result', { tool: tool.name, version: tool.version, result });
            raw.end();
            const durationMs = Math.round(performance.now() - started);
            request.log.info(
              { tool: tool.name, ...meta, stream: true, durationMs },
              'tool completed',
            );
            record(request, tool.name, undefined, durationMs);
          } catch (err) {
            if (!state.opened) throw err;
            const appError = resolveError(err as FastifyError, request);
            const errorBody: ErrorBody = {
              error: {
                code: appError.code,
                message: appError.message,
                details: appError.details,
                requestId: request.id,
              },
            };
            send('error', errorBody);
            raw.end();
            record(request, tool.name, appError.code, Math.round(performance.now() - started));
          }
          return reply;
        }

        const { result, meta } = await opts.engine.run(tool.name, {
          orgId,
          userId,
          input,
          requestId: request.id,
        });
        usage.set(request, {
          ...(meta.inputTokens !== undefined && { inputTokens: meta.inputTokens }),
          ...(meta.outputTokens !== undefined && { outputTokens: meta.outputTokens }),
          fallback: meta.fallback,
        });
        request.log.info(
          { tool: tool.name, ...meta, durationMs: Math.round(performance.now() - started) },
          'tool completed',
        );
        return { tool: tool.name, version: tool.version, result };
      },
    );
  }

  app.post('/v1/tools/:name', async () => {
    throw new AppError('unknown_tool', 404, 'Ferramenta desconhecida.');
  });
};
