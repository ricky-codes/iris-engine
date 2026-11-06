import { Value } from '@sinclair/typebox/value';
import type { AccessChecker } from './access.js';
import type { CircuitBreaker } from './breaker.js';
import { EngineError } from './errors.js';
import type { LlmProvider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { StringFieldStream, type StreamHandlers } from './stream.js';
import type { MemoryStore, RequestMemories } from './memory.js';
import { atStage, emptyTimings, markStage, type StageTimings } from './pipeline.js';
import type { RateLimiter } from './rate-limit.js';
import {
  fallbackChain,
  noOverrides,
  resolveOverrides,
  type EngineStore,
  type ToolSettings,
} from './store.js';
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
  /** Pedidos por minuto e por org (0 = sem limite). Por omissão, sem limite. */
  rateLimitPerMinute?: number;
  /** `false` recusa o streaming em todas as ferramentas. Por omissão, `true`. */
  streamEnabled?: boolean;
  /** Conta os pedidos para o limite por minuto. Sem ele, não há limite. */
  rateLimiter?: RateLimiter;
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
  /** Pede a resposta em streaming (só ferramentas com `stream`). */
  stream?: StreamHandlers;
}

/** Tudo o que vai para o modelo, já montado. */
export interface PreparedRun {
  settings: ToolSettings;
  memories: RequestMemories;
  system: string;
  user: string;
  /** JSON Schema da resposta (sem os símbolos internos do TypeBox). */
  schema: Record<string, unknown>;
  /** Quanto demorou cada passo até aqui (acesso, memórias, prompt), em ms. */
  timings: StageTimings;
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
  /** `skipped_breaker`: o modelo foi saltado, sem chamada (não conta como chamada). */
  reason: AttemptReason;
  fallback: boolean;
  /** Tentativa neste modelo, a começar em 1 (acima de 1: nova tentativa após resposta inválida). */
  attempt: number;
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
    /** Quanto demorou cada passo do motor, em ms. */
    timings: StageTimings;
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

const elapsed = (started: number): number => Math.round(performance.now() - started);

/**
 * Os passos antes do modelo, pela ordem do pipeline (`src/engine/pipeline.ts`): configuração
 * (ligada, streaming), limite de pedidos, acesso, memórias e prompt. Cada erro sai marcado com o
 * passo em que parou. O playground de admin usa isto sem limite, sem verificar acesso nem se a
 * ferramenta está ligada.
 */
export async function prepareRun(
  deps: Pick<
    EngineDeps,
    | 'access'
    | 'store'
    | 'memories'
    | 'defaultModel'
    | 'defaultFallbackModels'
    | 'maxAttempts'
    | 'totalTimeoutMs'
    | 'rateLimitPerMinute'
    | 'streamEnabled'
    | 'rateLimiter'
  >,
  tool: ToolDefinition,
  request: RunRequest,
  opts: {
    checkAccess: boolean;
    requireEnabled: boolean;
    /** Conta o pedido no limite por minuto (só os pedidos reais). */
    checkRateLimit?: boolean;
    systemPromptOverride?: string;
    modelOverride?: string;
    fallbackModelsOverride?: string[];
  },
): Promise<PreparedRun> {
  const timings = emptyTimings();
  const settings = await atStage('gate', async () => {
    const stored = await deps.store.settingsFor(tool.name, tool.defaults, {
      model: deps.defaultModel,
      fallbackModels: deps.defaultFallbackModels ?? [],
    });
    const model = opts.modelOverride ?? stored.model;
    const overrides = { ...noOverrides(), ...stored.overrides };
    const resolved = resolveOverrides(overrides, {
      maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      totalTimeoutMs: deps.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      rateLimitPerMinute: deps.rateLimitPerMinute ?? 0,
      streamEnabled: deps.streamEnabled ?? true,
    });
    const s: ToolSettings = {
      ...stored,
      model,
      fallbackModels: fallbackChain(model, opts.fallbackModelsOverride ?? stored.fallbackModels),
      overrides,
      maxAttempts: resolved.maxAttempts.value,
      totalTimeoutMs: resolved.totalTimeoutMs.value,
      rateLimitPerMinute: resolved.rateLimitPerMinute.value,
      streamEnabled: resolved.streamEnabled.value,
    };
    if (opts.requireEnabled && !s.enabled) {
      throw new EngineError('tool_disabled', 'Esta ferramenta está desativada.');
    }
    if (request.stream !== undefined && !s.streamEnabled) {
      throw new EngineError('invalid_request', 'O pedido não é válido.', [
        { path: 'body.stream', issue: 'o streaming está desativado para esta ferramenta' },
      ]);
    }
    return s;
  });

  // Antes de gastar utilização no StepAccess ou de chamar o modelo. Com um limite próprio, a
  // ferramenta conta à parte (por org e ferramenta); sem ele, as ferramentas partilham o da org.
  if (opts.checkRateLimit === true && deps.rateLimiter !== undefined) {
    const own = settings.overrides.rateLimitPerMinute !== null;
    const key = own ? `${request.orgId}\u0000${tool.name}` : request.orgId;
    const verdict = deps.rateLimiter.hit(key, settings.rateLimitPerMinute);
    if (!verdict.allowed) {
      throw markStage(
        new EngineError(
          'rate_limited',
          'Demasiados pedidos. Tente de novo em breve.',
          [],
          undefined,
          verdict.retryAfterSeconds,
        ),
        'rate',
      );
    }
  }

  if (opts.checkAccess) {
    const started = performance.now();
    try {
      await atStage('access', () =>
        deps.access.check({ orgId: request.orgId, userId: request.userId }),
      );
    } finally {
      timings.access = elapsed(started);
    }
  }

  let started = performance.now();
  const memories = await atStage('memories', () =>
    deps.memories.forRequest({ orgId: request.orgId, userId: request.userId, tool: tool.name }),
  );
  timings.memories = elapsed(started);

  started = performance.now();
  const prepared = await atStage('prompt', () => {
    const base = opts.systemPromptOverride ?? settings.systemPrompt ?? tool.systemPrompt;
    return {
      settings,
      memories,
      system: buildSystemPrompt(base, memories),
      user: tool.buildUserMessage(request.input),
      schema: JSON.parse(JSON.stringify(tool.output)) as Record<string, unknown>,
      timings,
    };
  });
  timings.prompt = elapsed(started);
  return prepared;
}

export interface CallModelOptions {
  /** Por omissão, os da configuração em vigor (`prepared.settings`). */
  maxAttempts?: number;
  totalTimeoutMs?: number;
  breaker?: CircuitBreaker | undefined;
  now?: () => number;
  onCall?: ((call: ModelCall) => void) | undefined;
  /** Streaming do campo de texto da ferramenta (`tool.stream`) para quem faz o pedido. */
  stream?: StreamHandlers | undefined;
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
  const maxAttempts = opts.maxAttempts ?? prepared.settings.maxAttempts;
  const deadline = now() + (opts.totalTimeoutMs ?? prepared.settings.totalTimeoutMs);
  const { timings } = prepared;
  const chain = [prepared.settings.model, ...prepared.settings.fallbackModels];
  const attempts: ModelAttempt[] = [];
  let error: EngineError | undefined;
  const streaming =
    opts.stream !== undefined && tool.stream !== undefined ? opts.stream : undefined;
  // Texto já enviado ao cliente por uma tentativa anterior: a seguinte começa por o anular.
  const sent = { text: false };

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
      opts.onCall?.({
        tool: tool.name,
        model,
        reason: 'skipped_breaker',
        fallback,
        attempt: 1,
        durationMs: 0,
      });
      continue;
    }

    for (let i = 1; i <= maxAttempts; i++) {
      const remaining = deadline - now();
      if (remaining < MIN_ATTEMPT_MS) return { result: undefined, attempts, error: budgetError() };

      const started = now();
      let attempt: ModelAttempt;
      let onText: ((chunk: string) => void) | undefined;
      if (streaming !== undefined && tool.stream !== undefined) {
        if (sent.text) {
          streaming.onReset();
          sent.text = false;
        }
        const field = new StringFieldStream(tool.stream.field);
        onText = (chunk) => {
          const text = field.feed(chunk);
          if (text === '') return;
          sent.text = true;
          try {
            streaming.onDelta(text);
          } catch {
            // Quem ouve (ex.: um cliente que fechou a ligação) não faz falhar o pedido.
          }
        };
      }
      const callStarted = performance.now();
      try {
        const response = await llm.complete({
          model,
          system: prepared.system,
          user: prepared.user,
          temperature: prepared.settings.temperature,
          maxOutputTokens: prepared.settings.maxOutputTokens,
          timeoutMs: Math.min(prepared.settings.timeoutMs, remaining),
          output: { name: `${tool.name}_result`, schema: prepared.schema },
          ...(onText !== undefined && { onText }),
        });
        timings.models += elapsed(callStarted);
        opts.breaker?.recordSuccess(model);
        const validated = performance.now();
        const parsed = parseModelJson(response.text);
        const valid = parsed !== undefined && Value.Check(tool.output, parsed);
        timings.validate += elapsed(validated);
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
          attempt: i,
          durationMs: attempt.durationMs,
        });
        if (valid) return { result: parsed, attempts, error: undefined };
        error = new EngineError(
          'invalid_model_output',
          'O modelo de IA devolveu uma resposta inválida. Tente de novo.',
        );
      } catch (err) {
        timings.models += elapsed(callStarted);
        if (!isProviderFailure(err)) throw err;
        const reason = err.code === 'timeout' ? 'timeout' : 'provider_unavailable';
        opts.breaker?.recordFailure(model, reason);
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
          attempt: i,
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
    checkRateLimit: true,
  });
  request.stream?.onStart?.();
  const { result, attempts, error } = await atStage('models', () =>
    callModel(deps.llm, tool, prepared, {
      ...(request.stream !== undefined && { stream: request.stream }),
      ...(deps.now !== undefined && { now: deps.now }),
      breaker: deps.breaker,
      onCall: deps.onModelCall,
    }),
  );
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
    // Resposta inválida: parou na validação; o resto (fornecedor, tempo): na cadeia de modelos.
    throw markStage(
      new EngineError(last.code, last.message, last.details, costUsd),
      last.code === 'invalid_model_output' ? 'validate' : 'models',
    );
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
      timings: prepared.timings,
    },
  };
}
