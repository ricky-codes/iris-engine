import type { AuthFailureReason, PipelineStage } from '../engine/pipeline.js';

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

/** As razões finas de um 401. Quem chama recebe sempre `unauthorized`, com a mesma mensagem. */
const AUTH_LABELS: Record<AuthFailureReason, string> = {
  auth_missing: 'Sem credencial',
  auth_bad_secret: 'Segredo partilhado errado',
  token_malformed: 'Token mal formado',
  token_unsupported_alg: 'Algoritmo do token não aceite (só HS256)',
  token_unknown_key: 'Chave desconhecida ou revogada',
  token_bad_signature: 'Assinatura do token errada',
  token_wrong_org: 'O token é de outra org que não a da chave',
  token_bad_claims: 'Campos do token em falta ou inválidos',
  token_wrong_audience: 'Token para outro serviço (aud)',
  token_not_yet_valid: 'Token emitido no futuro (relógio adiantado)',
  token_expired: 'Token expirado',
  token_ttl_too_long: 'Validade do token acima de 300 s',
  token_replayed: 'Token já usado (jti repetido)',
};

export const ERROR_CATALOG: ErrorCatalogEntry[] = [
  {
    code: 'unauthorized',
    stage: 'auth',
    httpStatus: 401,
    publicCode: 'unauthorized',
    label: 'Credencial recusada',
  },
  ...Object.entries(AUTH_LABELS).map(([code, label]) => ({
    code,
    stage: 'auth' as const,
    httpStatus: 401,
    publicCode: 'unauthorized',
    label,
  })),
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
