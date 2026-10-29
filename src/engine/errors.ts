/**
 * Os erros que o motor e os adaptadores lançam. O código é estável; quem usa o motor
 * decide como o mostrar (o servidor HTTP traduz cada código num estado).
 */
export const ENGINE_ERROR_CODES = [
  'access_denied',
  'quota_exceeded',
  'service_unavailable',
  'provider_unavailable',
  'timeout',
  'invalid_model_output',
  'invalid_request',
  'not_found',
  'forbidden',
  'memory_limit_reached',
  'unknown_tool',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export interface EngineErrorDetail {
  path: string;
  issue: string;
}

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
    public readonly details: EngineErrorDetail[] = [],
    /** O que o pedido já custou antes de falhar (as tentativas falhadas também se pagam). */
    public readonly costUsd?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
