import type { PipelineStage } from '../engine/pipeline.js';

/**
 * Os códigos estáveis de cada saída do caminho de um pedido, com o passo e o estado HTTP. São as
 * razões finas das métricas e dos traces; `publicCode` é o que o cliente de `/v1/tools` recebe
 * (esse contrato não muda).
 */
export interface ErrorCatalogEntry {
  code: string;
  stage: PipelineStage;
  httpStatus: number;
  publicCode: string;
  label: string;
}

export const ERROR_CATALOG: ErrorCatalogEntry[] = [
  {
    code: 'unauthorized',
    stage: 'request',
    httpStatus: 401,
    publicCode: 'unauthorized',
    label: 'Sem credencial ou credencial errada',
  },
  {
    code: 'invalid_request',
    stage: 'request',
    httpStatus: 422,
    publicCode: 'invalid_request',
    label: 'Pedido inválido (corpo, campos ou entrada da ferramenta)',
  },
  {
    code: 'payload_too_large',
    stage: 'request',
    httpStatus: 413,
    publicCode: 'payload_too_large',
    label: 'Corpo acima do limite',
  },
  {
    code: 'tool_disabled',
    stage: 'gate',
    httpStatus: 503,
    publicCode: 'tool_disabled',
    label: 'Ferramenta desligada',
  },
  {
    code: 'rate_limited',
    stage: 'rate',
    httpStatus: 429,
    publicCode: 'rate_limited',
    label: 'Acima do limite de pedidos por minuto',
  },
  {
    code: 'access_denied',
    stage: 'access',
    httpStatus: 403,
    publicCode: 'access_denied',
    label: 'Sem licença no StepAccess',
  },
  {
    code: 'quota_exceeded',
    stage: 'access',
    httpStatus: 429,
    publicCode: 'quota_exceeded',
    label: 'Limite do plano atingido',
  },
  {
    code: 'stepaccess_unavailable',
    stage: 'access',
    httpStatus: 503,
    publicCode: 'service_unavailable',
    label: 'StepAccess indisponível ou resposta inesperada',
  },
  {
    code: 'model_timeout',
    stage: 'models',
    httpStatus: 504,
    publicCode: 'timeout',
    label: 'O modelo demorou demasiado',
  },
  {
    code: 'provider_error',
    stage: 'models',
    httpStatus: 502,
    publicCode: 'provider_unavailable',
    label: 'O fornecedor do modelo falhou',
  },
  {
    code: 'all_models_failed',
    stage: 'models',
    httpStatus: 502,
    publicCode: 'provider_unavailable',
    label: 'Falharam todos os modelos da cadeia',
  },
  {
    code: 'invalid_output',
    stage: 'validate',
    httpStatus: 502,
    publicCode: 'invalid_model_output',
    label: 'A resposta não cumpre o esquema, em todas as tentativas',
  },
  {
    code: 'internal_error',
    stage: 'response',
    httpStatus: 500,
    publicCode: 'internal_error',
    label: 'Erro inesperado',
  },
];
