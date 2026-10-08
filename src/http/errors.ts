/**
 * Erros de domínio. Cada um tem um código estável (consumido pelo Salesforce)
 * e o estado HTTP correspondente. Nunca se lança uma string.
 *
 * Cada código existe também no catálogo `error_type` da base de dados; um teste
 * garante que as duas listas não divergem.
 */
export const ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'unknown_action',
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

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    requestId: string;
  };
}
