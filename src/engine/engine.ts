import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AccessChecker } from './access.js';
import { EngineError, type EngineErrorCode, type EngineErrorDetail } from './errors.js';
import type { LlmProvider } from './llm.js';
import { Memories, type MemoryStore } from './memory.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  callModel,
  prepareRun,
  runTool,
  type EngineDeps,
  type ModelAttempt,
  type PreparedRun,
  type RunRequest,
  type RunResult,
} from './run.js';
import type { EngineStore } from './store.js';
import type { ToolDefinition } from './tool.js';
import type { UsageReporter } from './usage.js';

/** O que se pode afinar no motor. Tudo o resto vem das ferramentas e dos adaptadores. */
export interface EngineSettings {
  /** Modelo usado quando a ferramenta não tem um configurado. */
  defaultModel: string;
  /** Quantas vezes se pede ao modelo uma resposta válida (1 a 5). Por omissão, 2. */
  maxAttempts?: number;
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
    };

export interface EngineOptions {
  settings: EngineSettings;
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
  /** Recebe um evento no fim de cada pedido. Um erro aqui nunca afeta o pedido. */
  onEvent?: (event: EngineEvent) => void;
}

/** Ajustes para experimentar uma ferramenta sem mexer na configuração guardada. */
export interface TrialOverrides {
  systemPrompt?: string;
  model?: string;
}

/**
 * O motor da IRIS: corre ferramentas e gere memórias. Não sabe de onde vêm os pedidos
 * (HTTP, uma fila, um script): quem o usa chama `run` e trata os `EngineError`.
 */
export interface Engine {
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
  ): Promise<{ prepared: PreparedRun; result: unknown; attempts: ModelAttempt[] }>;
  readonly memories: Memories;
}

const TOOL_NAME = /^[a-z_]+$/;

function checkSettings(settings: EngineSettings): Required<EngineSettings> {
  const maxAttempts = settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (settings.defaultModel.trim() === '') {
    throw new Error('Configuração do motor: defaultModel não pode estar vazio.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('Configuração do motor: maxAttempts tem de ser um inteiro de 1 a 5.');
  }
  return { defaultModel: settings.defaultModel, maxAttempts };
}

function registry(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Ferramenta com nome inválido: "${tool.name}" (só a-z e _).`);
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
  const settings = checkSettings(options.settings);
  const tools = registry(options.tools);
  const deps: EngineDeps = {
    access: options.access,
    store: options.store,
    memories: options.memories,
    llm: options.llm,
    defaultModel: settings.defaultModel,
    maxAttempts: settings.maxAttempts,
    ...(options.usage !== undefined && { usage: options.usage }),
  };

  const toolOr404 = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    if (tool === undefined) throw new EngineError('unknown_tool', 'Ferramenta desconhecida.');
    return tool;
  };

  const emit = (event: EngineEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Quem ouve não pode fazer falhar o pedido.
    }
  };

  return {
    settings,
    memories: new Memories(options.memories),
    tools: () => [...tools.values()],
    tool: (name) => tools.get(name),

    async run(name, request) {
      const tool = toolOr404(name);
      checkInput(tool, request.input);
      const started = performance.now();
      const base = {
        tool: tool.name,
        orgId: request.orgId,
        userId: request.userId,
        requestId: request.requestId,
      };
      try {
        const out = await runTool(deps, tool, request);
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
      return prepareRun(deps, tool, request, {
        checkAccess: false,
        requireEnabled: false,
        ...(overrides.systemPrompt !== undefined && {
          systemPromptOverride: overrides.systemPrompt,
        }),
        ...(overrides.model !== undefined && { modelOverride: overrides.model }),
      });
    },

    async trial(name, request, opts = {}) {
      const tool = toolOr404(name);
      checkInput(tool, request.input);
      const prepared = await prepareRun(deps, tool, request, {
        checkAccess: opts.checkAccess === true,
        requireEnabled: false,
        ...(opts.systemPrompt !== undefined && { systemPromptOverride: opts.systemPrompt }),
        ...(opts.model !== undefined && { modelOverride: opts.model }),
      });
      const { result, attempts } = await callModel(deps.llm, tool, prepared, settings.maxAttempts);
      return { prepared, result, attempts };
    },
  };
}
