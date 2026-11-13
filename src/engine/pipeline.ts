/**
 * Os passos de um pedido a uma ferramenta, pela ordem em que o código os executa
 * (`src/http/routes/tools.ts` e `src/engine/run.ts`). Cada erro fica marcado com o passo em que
 * o pedido parou, para as métricas e o diagrama da consola (`GET /v1/admin/tools/:name/pipeline`).
 */
export const PIPELINE_STAGES = [
  'auth', // credencial: token da org (ou segredo partilhado)
  'request', // corpo e entrada da ferramenta
  'gate', // configuração lida: ligada ou desligada, streaming permitido
  'rate', // limite de pedidos por minuto
  'access', // StepAccess (conta utilização)
  'memories', // memórias da org e do utilizador
  'prompt', // prompt de sistema e mensagem do utilizador
  'models', // cadeia de modelos, tentativas, disjuntor, teto de tempo
  'validate', // a resposta cumpre o esquema da ferramenta
  'response', // resposta ao cliente (JSON ou SSE) e envio do custo
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Tempo de cada passo do motor num pedido, em milissegundos. */
export interface StageTimings {
  /** Ler a configuração da ferramenta. */
  gate: number;
  /** Contar no limite de pedidos. */
  rate: number;
  access: number;
  memories: number;
  prompt: number;
  models: number;
  validate: number;
}

export const emptyTimings = (): StageTimings => ({
  gate: 0,
  rate: 0,
  access: 0,
  memories: 0,
  prompt: 0,
  models: 0,
  validate: 0,
});

/**
 * A razão fina de uma falha, para o catálogo `GET /v1/admin/errors`, as métricas e os traces.
 * Não muda o código que o cliente recebe (`/v1/tools` continua com os códigos de sempre).
 */
export type FailureReason =
  | AuthFailureReason
  | 'tool_disabled'
  | 'rate_limited'
  | 'access_denied'
  | 'quota_exceeded'
  | 'stepaccess_unavailable'
  | 'model_timeout'
  | 'provider_error'
  | 'all_models_failed'
  | 'invalid_output';

/** Porque é que a credencial foi recusada (todas dão 401 `unauthorized` a quem chama). */
export const AUTH_FAILURE_REASONS = [
  'auth_missing',
  'auth_bad_secret',
  'token_malformed',
  'token_unsupported_alg',
  'token_unknown_key',
  'token_bad_signature',
  'token_wrong_org',
  'token_bad_claims',
  'token_wrong_audience',
  'token_not_yet_valid',
  'token_expired',
  'token_ttl_too_long',
  'token_replayed',
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

const reasons = new WeakMap<object, FailureReason>();

export function markReason(err: unknown, reason: FailureReason): unknown {
  if (typeof err === 'object' && err !== null) reasons.set(err, reason);
  return err;
}

/** A razão fina, a partir da marca do motor ou do código e do passo. `undefined`: o próprio código. */
export function reasonOf(
  err: unknown,
  code: string,
  stage: PipelineStage,
): FailureReason | undefined {
  const marked = typeof err === 'object' && err !== null ? reasons.get(err) : undefined;
  if (marked !== undefined) return marked;
  if (code === 'tool_disabled' || code === 'rate_limited') return code;
  if (code === 'access_denied' || code === 'quota_exceeded') return code;
  if (stage === 'access' && code === 'service_unavailable') return 'stepaccess_unavailable';
  if (code === 'invalid_model_output') return 'invalid_output';
  if (code === 'timeout') return 'model_timeout';
  if (code === 'provider_unavailable') return 'provider_error';
  return undefined;
}

// O passo em que cada erro foi lançado. Um WeakMap para não mexer em erros de outros módulos.
const stages = new WeakMap<object, PipelineStage>();

/** Marca o erro com o passo (só o primeiro conta: o passo mais interior é o verdadeiro). */
export function markStage(err: unknown, stage: PipelineStage): unknown {
  if (typeof err === 'object' && err !== null && !stages.has(err)) stages.set(err, stage);
  return err;
}

/** O passo em que o erro foi lançado, se o motor o marcou. */
export function stageOf(err: unknown): PipelineStage | undefined {
  return typeof err === 'object' && err !== null ? stages.get(err) : undefined;
}

/** Corre `fn` e marca com `stage` qualquer erro que dela saia. */
export async function atStage<T>(stage: PipelineStage, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw markStage(err, stage);
  }
}
