import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type ErrorBody, type ErrorDetail } from './errors.js';

function toAppError(err: FastifyError): AppError {
  if (err instanceof AppError) return err;

  if (err.validation) {
    const details: ErrorDetail[] = err.validation.map((v) => ({
      path: [err.validationContext, ...v.instancePath.split('/').filter(Boolean)]
        .filter(Boolean)
        .join('.'),
      issue: v.message ?? 'inválido',
    }));
    return new AppError('invalid_request', 422, 'O pedido não é válido.', details);
  }

  switch (err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('payload_too_large', 413, 'O corpo do pedido excede o limite.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError('unsupported_media_type', 415, 'Content-Type não suportado.');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return new AppError('invalid_request', 400, 'Corpo do pedido em falta ou inválido.');
  }

  // Erros de parse de JSON e outros 4xx do Fastify.
  if (err.statusCode === 400) {
    return new AppError('invalid_request', 400, 'Corpo do pedido não é JSON válido.');
  }

  return new AppError('internal_error', 500, 'Erro interno.');
}

/**
 * Todas as respostas de erro saem neste formato. As mensagens nunca incluem
 * conteúdo do pedido, e os erros internos não expõem detalhes.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(err);

    if (appError.httpStatus >= 500) {
      request.log.error({ err }, 'request failed');
    } else {
      request.log.info({ code: appError.code, status: appError.httpStatus }, 'request rejected');
    }

    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
        requestId: request.id,
      },
    };
    return reply.status(appError.httpStatus).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorBody = {
      error: {
        code: 'not_found',
        message: 'Recurso não encontrado.',
        details: [],
        requestId: request.id,
      },
    };
    return reply.status(404).send(body);
  });
}
