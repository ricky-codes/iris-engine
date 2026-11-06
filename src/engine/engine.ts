import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AccessChecker } from './access.js';
import { BREAKER_OPEN_MS, BREAKER_THRESHOLD, CircuitBreaker, type OpenBreaker } from './breaker.js';
import { EngineError, type EngineErrorCode, type EngineErrorDetail } from './errors.js';
import { read, type Live } from './live.js';
import type { LlmProvider } from './llm.js';
import { Memories, type MemoryStore } from './memory.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  callModel,
  prepareRun,
  runTool,
  type EngineDeps,
  type ModelAttempt,
  type ModelCall,
  type PreparedRun,
  type RunRequest,
  type RunResult,
} from './run.js';
import { fallbackChain, type EngineStore } from './store.js';
import type { ToolDefinition } from './tool.js';
import type { UsageReporter } from './usage.js';

/** O que se pode afinar no motor. Tudo o resto vem das ferramentas e dos adaptadores. */
export interface EngineSettings {
  /** Modelo usado quando a ferramenta não tem um configurado. */
  defaultModel: string;
  /** Modelos de recurso das ferramentas sem configuração na base de dados (máximo 3). */
  fallbackModels?: string[];
  /** Quantas vezes se pede a cada modelo uma resposta válida (1 a 5). Por omissão, 2. */
  maxAttempts?: number;
  /** Teto de tempo para todas as chamadas ao modelo de um pedido (2 a 115 s). Por omissão, 30 s. */
  totalTimeoutMs?: number;
  /** Falhas seguidas do fornecedor para abrir o disjuntor de um modelo (1 a 20). Por omissão, 3. */
  breakerThreshold?: number;
  /** Durante quanto tempo o disjuntor aberto salta o modelo (1 s a 1 h). Por omissão, 60 s. */
  breakerOpenMs?: number;
}

/** O que aconteceu num pedido a uma ferramenta. Só metadados, nunca conteúdo. */
export type EngineEvent =
  | {
      type: 'run_completed';
      tool: string;
      orgId: string;
      userId: string;
      requestId: string | undefined;
      durationMs: number;
      model: string;
      /** `true` quando a resposta veio de um modelo de recurso. */
      fallback: boolean;
      attempts: number;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      costUsd: number | undefined;
      orgMemories: number;
      userMemories: number;
    }
  | {
      type: 'run_failed';
      tool: string;
      orgId: string;
      userId: string;
      requestId: string | undefined;
      durationMs: number;
      /** Código do erro do motor; `internal_error` para um erro inesperado. */
      code: EngineErrorCode | 'internal_error';
      costUsd: number | undefined;
    }
  | ({ type: 'model_call' } & ModelCall);

export interface EngineOptions {
  /** Fixas, ou lidas de novo em cada pedido (as que se mudam pela API de administração). */
  settings: Live<EngineSettings>;
  /** As ferramentas que o motor expõe. Os nomes têm de ser únicos. */
  tools: ToolDefinition[];
  /** Quem decide se o pedido pode avançar (ex.: StepAccess, ou deixar passar tudo). */
  access: AccessChecker;
  /** A configuração de cada ferramenta (modelo, prompt ativo, ligada ou não). */
  store: EngineStore;
  /** Onde vivem as memórias das orgs e dos utilizadores. */
  memories: MemoryStore;
  llm: LlmProvider;
  /** Para onde vai o custo de cada pedido. Opcional. */
  usage?: UsageReporter;
  /** Recebe um evento no fim de cada pedido e de cada chamada ao modelo. Nunca afeta o pedido. */
  onEvent?: (event: EngineEvent) => void;
  /** Relógio em milissegundos, para o teto de tempo e o disjuntor (os testes passam um falso). */
  now?: () => number;
}

/** Ajustes para experimentar uma ferramenta sem mexer na configuração guardada. */
export interface TrialOverrides {
  systemPrompt?: string;
  model?: string;
  fallbackModels?: string[];
}

/**
 * O motor da IRIS: corre ferramentas e gere memórias. Não sabe de onde vêm os pedidos
 * (HTTP, uma fila, um script): quem o usa chama `run` e trata os `EngineError`.
 */
export interface Engine {
  /** As definições em vigor agora. */
  readonly settings: Readonly<Required<EngineSettings>>;
  /** As ferramentas disponíveis, pela ordem em que foram registadas. */
  tools(): readonly ToolDefinition[];
  tool(name: string): ToolDefinition | undefined;
  /**
   * Corre uma ferramenta: valida a entrada, lê a configuração, verifica o acesso,
   * junta as memórias, chama o modelo e valida a resposta. Nada é guardado.
   */
  run(name: string, request: RunRequest): Promise<RunResult>;
  /** Monta o que iria para o modelo, sem verificar acesso nem chamar o modelo. */
  preview(name: string, request: RunRequest, overrides?: TrialOverrides): Promise<PreparedRun>;
  /**
   * Experimenta uma ferramenta, mesmo desligada, com prompt ou modelo à escolha.
   * Só verifica o acesso (e conta utilização) com `checkAccess`.
   */
  trial(
    name: string,
    request: RunRequest,
    options?: TrialOverrides & { checkAccess?: boolean },
  ): Promise<{
    prepared: PreparedRun;
    result: unknown;
    attempts: ModelAttempt[];
    /** Quando toda a cadeia falhou: o erro da última tentativa. */
    error: EngineError | undefined;
  }>;
  readonly memories: Memories;
  /** Os modelos que o disjuntor está a saltar agora. */
  openBreakers(): OpenBreaker[];
  /** Fecha o disjuntor de um modelo, ou de todos. Devolve os modelos que estavam abertos. */
  resetBreakers(model?: string): string[];
}

const TOOL_NAME = /^[a-z_]+$/;

function checkSettings(settings: EngineSettings): Required<EngineSettings> {
  const maxAttempts = settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const totalTimeoutMs = settings.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const fallbackModels = fallbackChain(settings.defaultModel, settings.fallbackModels ?? []);
  if (settings.defaultModel.trim() === '') {
    throw new Error('Configuração do motor: defaultModel não pode estar vazio.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('Configuração do motor: maxAttempts tem de ser um inteiro de 1 a 5.');
  }
  if (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 2000 || totalTimeoutMs > 115_000) {
    throw new Error(
      'Configuração do motor: totalTimeoutMs tem de ser um inteiro de 2000 a 115000.',
    );
  }
  if (fallbackModels.length > 3 || fallbackModels.some((m) => m.trim() === '')) {
    throw new Error('Configuração do motor: no máximo 3 modelos de recurso, sem nomes vazios.');
  }
  const breakerThreshold = settings.breakerThreshold ?? BREAKER_THRESHOLD;
  const breakerOpenMs = settings.breakerOpenMs ?? BREAKER_OPEN_MS;
  if (!Number.isInteger(breakerThreshold) || breakerThreshold < 1 || breakerThreshold > 20) {
    throw new Error('Configuração do motor: breakerThreshold tem de ser um inteiro de 1 a 20.');
  }
  if (!Number.isInteger(breakerOpenMs) || breakerOpenMs < 1000 || breakerOpenMs > 3_600_000) {
    throw new Error(
      'Configuração do motor: breakerOpenMs tem de ser um inteiro de 1000 a 3600000.',
    );
  }
  return {
    defaultModel: settings.defaultModel,
    fallbackModels,
    maxAttempts,
    totalTimeoutMs,
    breakerThreshold,
    breakerOpenMs,
  };
}

function registry(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Ferramenta com nome inválido: "${tool.name}" (só a-z e _).`);
    }
    if (tool.stream !== undefined) {
      const prop = tool.output.properties[tool.stream.field] as { type?: unknown } | undefined;
      if (prop?.type !== 'string') {
        throw new Error(
          `Ferramenta "${tool.name}": stream.field ("${tool.stream.field}") tem de ser uma propriedade de texto da saída.`,
        );
      }
    }
    if (byName.has(tool.name)) throw new Error(`Ferramenta repetida: "${tool.name}".`);
    byName.set(tool.name, tool);
  }
  return byName;
}

/** A entrada tem de cumprir o esquema da ferramenta, sem campos a mais. */
function checkInput(tool: ToolDefinition, input: Record<string, unknown>): void {
  const schema = Type.Object(tool.input.properties, { additionalProperties: false });
  const details: EngineErrorDetail[] = [...Value.Errors(schema, input)].map((e) => ({
    path: ['input', ...e.path.split('/').filter(Boolean)].join('.'),
    issue: e.message,
  }));
  if (details.length > 0) {
    throw new EngineError('invalid_request', 'A entrada da ferramenta não é válida.', details);
  }
}

export function createEngine(options: EngineOptions): Engine {
  const tools = registry(options.tools);
  const now = options.now ?? (() => Date.now());
  // Validadas no arranque; depois, só quando o objeto muda (as definições vivas mantêm-no igual
  // enquanto nada muda), para não validar em cada pedido.
  let raw = read(options.settings);
  let settings = checkSettings(raw);
  const breaker = new CircuitBreaker(now, settings.breakerThreshold, settings.breakerOpenMs);
  const current = (): Required<EngineSettings> => {
    const next = read(options.settings);
    if (next !== raw) {
      settings = checkSettings(next);
      raw = next;
      breaker.configure(settings.breakerThreshold, settings.breakerOpenMs);
    }
    return settings;
  };

  const emit = (event: EngineEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Quem ouve não pode fazer falhar o pedido.
    }
  };

  const deps = (): EngineDeps => {
    const s = current();
    return {
      access: options.access,
      store: options.store,
      memories: options.memories,
      llm: options.llm,
      defaultModel: s.defaultModel,
      defaultFallbackModels: s.fallbackModels,
      maxAttempts: s.maxAttempts,
      totalTimeoutMs: s.totalTimeoutMs,
      breaker,
      now,
      onModelCall: (call) => {
        emit({ type: 'model_call', ...call });
      },
      ...(options.usage !== undefined && { usage: options.usage }),
    };
  };

  const toolOr404 = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    if (tool === undefined) throw new EngineError('unknown_tool', 'Ferramenta desconhecida.');
    return tool;
  };

  return {
    get settings() {
      return current();
    },
    memories: new Memories(options.memories),
    openBreakers: () => breaker.open(),
    resetBreakers: (model) => breaker.reset(model),
    tools: () => [...tools.values()],
    tool: (name) => tools.get(name),

    async run(name, request) {
      const tool = toolOr404(name);
      checkInput(tool, request.input);
      if (request.stream !== undefined && tool.stream === undefined) {
        throw new EngineError('invalid_request', 'Esta ferramenta não suporta streaming.', [
          { path: 'stream', issue: 'esta ferramenta não suporta streaming' },
        ]);
      }
      const started = performance.now();
      const base = {
        tool: tool.name,
        orgId: request.orgId,
        userId: request.userId,
        requestId: request.requestId,
      };
      try {
        const out = await runTool(deps(), tool, request);
        emit({
          type: 'run_completed',
          ...base,
          durationMs: Math.round(performance.now() - started),
          ...out.meta,
        });
        return out;
      } catch (err) {
        emit({
          type: 'run_failed',
          ...base,
          durationMs: Math.round(performance.now() - started),
          code: err instanceof EngineError ? err.code : 'internal_error',
          costUsd: err instanceof EngineError ? err.costUsd : undefined,
        });
        throw err;
      }
    },

    async preview(name, request, overrides = {}) {
      const tool = toolOr404(name);
      checkInput(tool, request.input);
      return prepareRun(deps(), tool, request, {
        checkAccess: false,
        requireEnabled: false,
        ...(overrides.systemPrompt !== undefined && {
          systemPromptOverride: overrides.systemPrompt,
        }),
        ...(overrides.model !== undefined && { modelOverride: overrides.model }),
        ...(overrides.fallbackModels !== undefined && {
          fallbackModelsOverride: overrides.fallbackModels,
        }),
      });
    },

    async trial(name, request, opts = {}) {
      const tool = toolOr404(name);
      checkInput(tool, request.input);
      const d = deps();
      const prepared = await prepareRun(d, tool, request, {
        checkAccess: opts.checkAccess === true,
        requireEnabled: false,
        ...(opts.systemPrompt !== undefined && { systemPromptOverride: opts.systemPrompt }),
        ...(opts.model !== undefined && { modelOverride: opts.model }),
        ...(opts.fallbackModels !== undefined && { fallbackModelsOverride: opts.fallbackModels }),
      });
      // O playground usa o mesmo disjuntor, mas não entra nas métricas (sem onCall).
      const { result, attempts, error } = await callModel(d.llm, tool, prepared, {
        maxAttempts: d.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        totalTimeoutMs: d.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
        breaker,
        now,
      });
      return { prepared, result, attempts, error };
    },
  };
}
