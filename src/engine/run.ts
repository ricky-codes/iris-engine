import { Value } from '@sinclair/typebox/value';
import type { AccessChecker } from './access.js';
import type { CircuitBreaker } from './breaker.js';
import { EngineError } from './errors.js';
import type { LlmProvider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import type { MemoryStore, RequestMemories } from './memory.js';
import { fallbackChain, type EngineStore, type ToolSettings } from './store.js';
import type { ToolDefinition } from './tool.js';
import type { UsageReporter } from './usage.js';

export interface EngineDeps {
  access: AccessChecker;
  store: EngineStore;
  /** De onde vêm as memórias da org e do utilizador (`Memories` ou um `MemoryStore`). */
  memories: Pick<MemoryStore, 'forRequest'>;
  llm: LlmProvider;
  defaultModel: string;
  /** Modelos de recurso das ferramentas sem configuração na base de dados. */
  defaultFallbackModels?: string[];
  /** Quantas vezes se pede a cada modelo uma resposta válida. Por omissão, 2. */
  maxAttempts?: number;
  /** Teto de tempo para todas as chamadas ao modelo de um pedido. Por omissão, 30 s. */
  totalTimeoutMs?: number;
  /** Salta modelos que estão a falhar. Sem ele, todos os modelos são sempre experimentados. */
  breaker?: CircuitBreaker;
  /** Relógio em milissegundos (os testes passam um falso). */
  now?: () => number;
  /** Uma chamada ao modelo terminou. Só metadados. */
  onModelCall?: (call: ModelCall) => void;
  /** Para onde vai o custo de cada pedido. Sem ele, o custo só fica no log. */
  usage?: UsageReporter;
}

export interface RunRequest {
  orgId: string;
  userId: string;
  input: Record<string, unknown>;
  /** Id do pedido HTTP, enviado com o custo. */
  requestId?: string;
}

/** Tudo o que vai para o modelo, já montado. */
export interface PreparedRun {
  settings: ToolSettings;
  memories: RequestMemories;
  system: string;
  user: string;
  /** JSON Schema da resposta (sem os símbolos internos do TypeBox). */
  schema: Record<string, unknown>;
}

/**
 * Como acabou uma tentativa: `ok` (resposta válida), `invalid_output` (não cumpre o esquema),
 * `provider_unavailable` / `timeout` (o fornecedor falhou), `skipped_breaker` (modelo saltado).
 */
export type AttemptReason =
  'ok' | 'invalid_output' | 'provider_unavailable' | 'timeout' | 'skipped_breaker';

export interface ModelAttempt {
  /** O texto devolvido pelo modelo; `null` quando não houve resposta. */
  text: string | null;
  valid: boolean;
  reason: AttemptReason;
  /** `true` quando o modelo não é o principal da ferramenta. */
  fallback: boolean;
  /** O modelo pedido. */
  requestedModel: string;
  /** O modelo que de facto respondeu (o OpenRouter pode indicar uma variante). */
  model: string;
  durationMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
}

/** Uma chamada feita ao modelo, para as métricas. Nunca conteúdo. */
export interface ModelCall {
  tool: string;
  model: string;
  reason: Exclude<AttemptReason, 'skipped_breaker'>;
  fallback: boolean;
  durationMs: number;
}

export interface RunResult {
  result: unknown;
  /** Só metadados, para os logs e as métricas. Nunca conteúdo. */
  meta: {
    /** O modelo que deu a resposta válida. */
    model: string;
    /** `true` quando a resposta veio de um modelo de recurso. */
    fallback: boolean;
    /** Chamadas feitas ao modelo (sem contar os modelos saltados). */
    attempts: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    /** Custo do pedido em dólares: soma de todas as tentativas ao modelo. */
    costUsd: number | undefined;
    orgMemories: number;
    userMemories: number;
  };
}

export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
/** Não se começa uma tentativa com menos tempo do que isto no orçamento. */
export const MIN_ATTEMPT_MS = 1000;

/** Lê o JSON devolvido pelo modelo. Aceita-o dentro de um bloco ```json, que alguns modelos usam. */
export function parseModelJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  try {
    return JSON.parse(fenced?.[1] ?? text);
  } catch {
    return undefined;
  }
}

/**
 * Lê a configuração, (opcionalmente) verifica o acesso e monta o prompt com as memórias.
 * O playground de admin usa isto sem verificar acesso nem se a ferramenta está ligada.
 */
export async function prepareRun(
  deps: Pick<
    EngineDeps,
    'access' | 'store' | 'memories' | 'defaultModel' | 'defaultFallbackModels'
  >,
  tool: ToolDefinition,
  request: RunRequest,
  opts: {
    checkAccess: boolean;
    requireEnabled: boolean;
    systemPromptOverride?: string;
    modelOverride?: string;
    fallbackModelsOverride?: string[];
  },
): Promise<PreparedRun> {
  const stored = await deps.store.settingsFor(tool.name, tool.defaults, {
    model: deps.defaultModel,
    fallbackModels: deps.defaultFallbackModels ?? [],
  });
  const model = opts.modelOverride ?? stored.model;
  const settings: ToolSettings = {
    ...stored,
    model,
    fallbackModels: fallbackChain(model, opts.fallbackModelsOverride ?? stored.fallbackModels),
  };
  if (opts.requireEnabled && !settings.enabled) {
    throw new EngineError('service_unavailable', 'Esta ferramenta está desativada.');
  }

  if (opts.checkAccess) await deps.access.check({ orgId: request.orgId, userId: request.userId });

  const memories = await deps.memories.forRequest({
    orgId: request.orgId,
    userId: request.userId,
    tool: tool.name,
  });
  const base = opts.systemPromptOverride ?? settings.systemPrompt ?? tool.systemPrompt;
  return {
    settings,
    memories,
    system: buildSystemPrompt(base, memories),
    user: tool.buildUserMessage(request.input),
    schema: JSON.parse(JSON.stringify(tool.output)) as Record<string, unknown>,
  };
}

export interface CallModelOptions {
  maxAttempts?: number;
  totalTimeoutMs?: number;
  breaker?: CircuitBreaker | undefined;
  now?: () => number;
  onCall?: ((call: ModelCall) => void) | undefined;
}

export interface CallModelResult {
  /** A resposta válida, ou `undefined` se toda a cadeia falhou. */
  result: unknown;
  attempts: ModelAttempt[];
  /** Quando toda a cadeia falhou: o erro da última tentativa. */
  error: EngineError | undefined;
}

const isProviderFailure = (err: unknown): err is EngineError =>
  err instanceof EngineError && (err.code === 'provider_unavailable' || err.code === 'timeout');

/**
 * Chama os modelos da ferramenta por ordem: o principal e depois os de recurso.
 * - O fornecedor falhou (`provider_unavailable`, `timeout`): passa logo ao modelo seguinte.
 * - A resposta não cumpre o esquema: tenta outra vez no mesmo modelo; à segunda, passa ao seguinte.
 * - Um modelo com o disjuntor aberto é saltado, a não ser que seja o último da cadeia.
 * - Cada chamada usa o `timeoutMs` da ferramenta, dentro de um teto para o pedido inteiro;
 *   não se começa uma tentativa com menos de 1 s de orçamento.
 */
export async function callModel(
  llm: LlmProvider,
  tool: ToolDefinition,
  prepared: PreparedRun,
  opts: CallModelOptions = {},
): Promise<CallModelResult> {
  const now = opts.now ?? (() => Date.now());
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deadline = now() + (opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const chain = [prepared.settings.model, ...prepared.settings.fallbackModels];
  const attempts: ModelAttempt[] = [];
  let error: EngineError | undefined;

  const budgetError = (): EngineError =>
    new EngineError('timeout', 'O modelo de IA demorou demasiado a responder.');

  for (const [index, model] of chain.entries()) {
    const fallback = index > 0;
    const isLast = index === chain.length - 1;
    if (!isLast && opts.breaker?.isOpen(model) === true) {
      attempts.push({
        text: null,
        valid: false,
        reason: 'skipped_breaker',
        fallback,
        requestedModel: model,
        model,
        durationMs: 0,
        inputTokens: undefined,
        outputTokens: undefined,
        costUsd: undefined,
      });
      continue;
    }

    for (let i = 1; i <= maxAttempts; i++) {
      const remaining = deadline - now();
      if (remaining < MIN_ATTEMPT_MS) return { result: undefined, attempts, error: budgetError() };

      const started = now();
      let attempt: ModelAttempt;
      try {
        const response = await llm.complete({
          model,
          system: prepared.system,
          user: prepared.user,
          temperature: prepared.settings.temperature,
          maxOutputTokens: prepared.settings.maxOutputTokens,
          timeoutMs: Math.min(prepared.settings.timeoutMs, remaining),
          output: { name: `${tool.name}_result`, schema: prepared.schema },
        });
        opts.breaker?.recordSuccess(model);
        const parsed = parseModelJson(response.text);
        const valid = parsed !== undefined && Value.Check(tool.output, parsed);
        attempt = {
          text: response.text,
          valid,
          reason: valid ? 'ok' : 'invalid_output',
          fallback,
          requestedModel: model,
          model: response.model,
          durationMs: Math.round(now() - started),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: response.costUsd,
        };
        attempts.push(attempt);
        opts.onCall?.({
          tool: tool.name,
          model,
          reason: attempt.reason === 'ok' ? 'ok' : 'invalid_output',
          fallback,
          durationMs: attempt.durationMs,
        });
        if (valid) return { result: parsed, attempts, error: undefined };
        error = new EngineError(
          'invalid_model_output',
          'O modelo de IA devolveu uma resposta inválida. Tente de novo.',
        );
      } catch (err) {
        if (!isProviderFailure(err)) throw err;
        opts.breaker?.recordFailure(model);
        const reason = err.code === 'timeout' ? 'timeout' : 'provider_unavailable';
        attempts.push({
          text: null,
          valid: false,
          reason,
          fallback,
          requestedModel: model,
          model,
          durationMs: Math.round(now() - started),
          inputTokens: undefined,
          outputTokens: undefined,
          costUsd: undefined,
        });
        opts.onCall?.({
          tool: tool.name,
          model,
          reason,
          fallback,
          durationMs: Math.round(now() - started),
        });
        error = err;
        break;
      }
    }
  }
  return { result: undefined, attempts, error: error ?? budgetError() };
}

/** Soma valores opcionais (tokens, custo); `undefined` se nenhum vier preenchido. */
const sumTokens = (values: (number | undefined)[]): number | undefined =>
  values.every((v) => v === undefined)
    ? undefined
    : values.reduce<number>((s, v) => s + (v ?? 0), 0);

/**
 * O caminho de um pedido com a entrada já validada (ver `Engine.run`):
 * configuração → acesso (no StepAccess, conta utilização) → memórias → modelos → validação.
 * Nada é guardado.
 */
export async function runTool(
  deps: EngineDeps,
  tool: ToolDefinition,
  request: RunRequest,
): Promise<RunResult> {
  const prepared = await prepareRun(deps, tool, request, {
    checkAccess: true,
    requireEnabled: true,
  });
  const { result, attempts, error } = await callModel(deps.llm, tool, prepared, {
    ...(deps.maxAttempts !== undefined && { maxAttempts: deps.maxAttempts }),
    ...(deps.totalTimeoutMs !== undefined && { totalTimeoutMs: deps.totalTimeoutMs }),
    ...(deps.now !== undefined && { now: deps.now }),
    breaker: deps.breaker,
    onCall: deps.onModelCall,
  });
  const called = attempts.filter((a) => a.reason !== 'skipped_breaker');
  // Só as tentativas com resposta foram pagas; o custo vai para o StepAccess só nesse caso.
  const answered = called.filter((a) => a.text !== null);
  const served = answered.find((a) => a.valid) ?? answered[answered.length - 1];
  const costUsd = sumTokens(called.map((a) => a.costUsd));
  const inputTokens = sumTokens(called.map((a) => a.inputTokens));
  const outputTokens = sumTokens(called.map((a) => a.outputTokens));
  if (served !== undefined && request.requestId !== undefined) {
    deps.usage?.report({
      requestId: request.requestId,
      orgId: request.orgId,
      userId: request.userId,
      tool: tool.name,
      outcome: result === undefined ? 'invalid_model_output' : 'success',
      model: served.model,
      attempts: called.length,
      inputTokens,
      outputTokens,
      costUsd,
      occurredAt: new Date().toISOString(),
    });
  }
  if (result === undefined || served === undefined || !served.valid) {
    // As tentativas falhadas também custam: o custo vai no erro, para o log.
    const last =
      error ?? new EngineError('timeout', 'O modelo de IA demorou demasiado a responder.');
    throw new EngineError(last.code, last.message, last.details, costUsd);
  }
  return {
    result,
    meta: {
      model: served.model,
      fallback: served.fallback,
      attempts: called.length,
      inputTokens,
      outputTokens,
      costUsd,
      orgMemories: prepared.memories.org.length,
      userMemories: prepared.memories.user.length,
    },
  };
}
