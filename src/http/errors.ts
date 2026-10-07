/**
 * Erros de domínio. Cada um tem um código estável (consumido pelo Salesforce)
 * e o estado HTTP correspondente. Nunca se lança uma string.
 */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unknown_action'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'not_implemented'
  | 'invalid_model_output'
  | 'provider_unavailable'
  | 'timeout'
  | 'internal_error';

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
