import type { EngineError, EngineErrorCode } from '../engine/errors.js';

/**
 * Erros de domínio. Cada um tem um código estável (consumido pelo Salesforce)
 * e o estado HTTP correspondente. Nunca se lança uma string.
 */
export const ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'access_denied',
  'quota_exceeded',
  'memory_limit_reached',
  'not_found',
  'unknown_tool',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'not_implemented',
  'invalid_model_output',
  'provider_unavailable',
  'timeout',
  'internal_error',
  'service_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  path: string;
  issue: string;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details: ErrorDetail[] = [],
    /** Cabeçalhos HTTP a acrescentar à resposta (por exemplo `WWW-Authenticate`). */
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Estado HTTP de cada erro do motor. */
const ENGINE_HTTP_STATUS: Record<EngineErrorCode, number> = {
  access_denied: 403,
  quota_exceeded: 429,
  service_unavailable: 503,
  provider_unavailable: 502,
  timeout: 504,
  invalid_model_output: 502,
  invalid_request: 422,
  not_found: 404,
  forbidden: 403,
  memory_limit_reached: 409,
};

/** Um erro do motor no formato da API. O código e a mensagem passam tal como estão. */
export function fromEngineError(err: EngineError): AppError {
  return new AppError(err.code, ENGINE_HTTP_STATUS[err.code], err.message, err.details);
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    requestId: string;
  };
}
