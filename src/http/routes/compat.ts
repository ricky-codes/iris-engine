import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyError, FastifyRequest } from 'fastify';
import { runTool } from '../../engine/run.js';
import { errorCodeOf, resolveError } from '../error-handler.js';
import { AppError } from '../errors.js';
import { bearerAuth, type ToolRoutesOptions } from './tools.js';

/** Ações do IRIS Hub (n8n) e a ferramenta da IRIS que responde a cada uma. */
const ACTION_TOOLS: Record<string, string | undefined> = {
  sentiment: 'sentiment',
  tipification: 'tipification',
  reply: 'reply',
  knowledge: undefined,
};

/** Campos do Case que o Apex envia. Tudo o resto no corpo é ignorado. */
const CASE_FIELDS = [
  'case',
  'account',
  'contact',
  'relatedCases',
  'caseComments',
  'emailMessages',
  'payload',
] as const;

const Body = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 40 }),
    orgId: Type.String({ pattern: '^00D[A-Za-z0-9]{15}$' }),
    userId: Type.String({ pattern: '^005[A-Za-z0-9]{15}$' }),
  },
  // O Apex envia mais campos (orgUrl, recordId, ts…). Aceitam-se e ignoram-se.
  { additionalProperties: true },
);

/**
 * `POST /v1/compat/n8n`: aceita o pedido do IRIS Hub tal como o Apex o envia hoje
 * (um só URL, com `action`) e responde com o mesmo envelope `{success, data}`.
 * Permite migrar uma org do n8n para a IRIS só trocando o URL e o segredo.
 */
export const compatRoutes: FastifyPluginAsyncTypebox<ToolRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', bearerAuth(opts.apiSecret));

  // Aqui os erros saem no envelope do Hub: {success:false, error:{message}}.
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply) => {
    const e = resolveError(err, request);
    return reply
      .status(e.httpStatus)
      .headers(e.headers)
      .send({
        success: false,
        error: { code: e.code, message: e.message, details: e.details, requestId: request.id },
      });
  });

  const usage = new WeakMap<
    FastifyRequest,
    { tool: string; inputTokens?: number; outputTokens?: number }
  >();

  app.addHook('onResponse', async (request, reply) => {
    const used = usage.get(request);
    if (opts.metrics === undefined || used === undefined) return;
    opts.metrics.record({
      tool: used.tool,
      errorCode: reply.statusCode < 400 ? undefined : (errorCodeOf(request) ?? 'internal_error'),
      durationMs: reply.elapsedTime,
      inputTokens: used.inputTokens,
      outputTokens: used.outputTokens,
    });
  });

  app.post('/v1/compat/n8n', { schema: { body: Body } }, async (request) => {
    const body = request.body as Record<string, unknown> & {
      action: string;
      orgId: string;
      userId: string;
    };

    if (!Object.hasOwn(ACTION_TOOLS, body.action)) {
      throw new AppError('invalid_request', 422, 'O pedido não é válido.', [
        { path: 'body.action', issue: 'ação desconhecida' },
      ]);
    }
    const toolName = ACTION_TOOLS[body.action];
    const tool = opts.tools.find((t) => t.name === toolName);
    // Antes do StepAccess: uma ação que ainda não existe não gasta utilização.
    if (tool === undefined) {
      throw new AppError(
        'not_implemented',
        501,
        `A ação "${body.action}" ainda não está disponível.`,
      );
    }

    const input = Object.fromEntries(CASE_FIELDS.filter((k) => k in body).map((k) => [k, body[k]]));
    usage.set(request, { tool: tool.name });
    const started = performance.now();
    const { result, meta } = await runTool(opts.deps, tool, {
      orgId: body.orgId,
      userId: body.userId,
      input,
      requestId: request.id,
    });
    usage.set(request, {
      tool: tool.name,
      ...(meta.inputTokens !== undefined && { inputTokens: meta.inputTokens }),
      ...(meta.outputTokens !== undefined && { outputTokens: meta.outputTokens }),
    });
    request.log.info(
      {
        tool: tool.name,
        via: 'compat',
        ...meta,
        durationMs: Math.round(performance.now() - started),
      },
      'tool completed',
    );
    return { success: true, data: result };
  });
};
