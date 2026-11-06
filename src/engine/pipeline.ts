/**
 * Os passos de um pedido a uma ferramenta, pela ordem em que o código os executa
 * (`src/http/routes/tools.ts` e `src/engine/run.ts`). Cada erro fica marcado com o passo em que
 * o pedido parou, para as métricas e o diagrama da consola (`GET /v1/admin/tools/:name/pipeline`).
 */
export const PIPELINE_STAGES = [
  'request', // credencial, corpo e entrada da ferramenta
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
  access: number;
  memories: number;
  prompt: number;
  models: number;
  validate: number;
}

export const emptyTimings = (): StageTimings => ({
  access: 0,
  memories: 0,
  prompt: 0,
  models: 0,
  validate: 0,
});

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
