import { Value } from '@sinclair/typebox/value';
import { AppError } from '../http/errors.js';
import type { AccessChecker } from './access.js';
import type { LlmProvider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import type { EngineStore, RequestMemories, ToolSettings } from './store.js';
import type { ToolDefinition } from './tool.js';

export interface EngineDeps {
  access: AccessChecker;
  store: EngineStore;
  llm: LlmProvider;
  defaultModel: string;
}

export interface RunRequest {
  orgId: string;
  userId: string;
  input: Record<string, unknown>;
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

export interface ModelAttempt {
  text: string;
  valid: boolean;
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
}

export interface RunResult {
  result: unknown;
  /** Só metadados, para os logs e as métricas. Nunca conteúdo. */
  meta: {
    model: string;
    attempts: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    /** Custo do pedido em dólares: soma de todas as tentativas ao modelo. */
    costUsd: number | undefined;
    orgMemories: number;
    userMemories: number;
  };
}

const MAX_ATTEMPTS = 2;

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
 * Lê a configuração, (opcionalmente) pergunta ao StepAccess e monta o prompt com as memórias.
 * O playground de admin usa isto sem verificar acesso nem se a ferramenta está ligada.
 */
export async function prepareRun(
  deps: Pick<EngineDeps, 'access' | 'store' | 'defaultModel'>,
  tool: ToolDefinition,
  request: RunRequest,
  opts: {
    checkAccess: boolean;
    requireEnabled: boolean;
    systemPromptOverride?: string;
    modelOverride?: string;
  },
): Promise<PreparedRun> {
  const stored = await deps.store.settingsFor(tool.name, tool.defaults, deps.defaultModel);
  const settings: ToolSettings =
    opts.modelOverride === undefined ? stored : { ...stored, model: opts.modelOverride };
  if (opts.requireEnabled && !settings.enabled) {
    throw new AppError('service_unavailable', 503, 'Esta ferramenta está desativada.');
  }

  if (opts.checkAccess) await deps.access.check({ orgId: request.orgId, userId: request.userId });

  const memories = await deps.store.memoriesFor({
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

/**
 * Chama o modelo e valida a resposta contra o esquema da ferramenta. Se a primeira resposta
 * não for válida, tenta outra vez. Devolve o resultado válido (ou `undefined`) e as tentativas.
 */
export async function callModel(
  llm: LlmProvider,
  tool: ToolDefinition,
  prepared: PreparedRun,
): Promise<{ result: unknown; attempts: ModelAttempt[] }> {
  const attempts: ModelAttempt[] = [];
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const response = await llm.complete({
      model: prepared.settings.model,
      system: prepared.system,
      user: prepared.user,
      temperature: prepared.settings.temperature,
      maxOutputTokens: prepared.settings.maxOutputTokens,
      timeoutMs: prepared.settings.timeoutMs,
      output: { name: `${tool.name}_result`, schema: prepared.schema },
    });
    const parsed = parseModelJson(response.text);
    const valid = parsed !== undefined && Value.Check(tool.output, parsed);
    attempts.push({
      text: response.text,
      valid,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
    });
    if (valid) return { result: parsed, attempts };
  }
  return { result: undefined, attempts };
}

/** Soma valores opcionais (tokens, custo); `undefined` se nenhum vier preenchido. */
const sumTokens = (values: (number | undefined)[]): number | undefined =>
  values.every((v) => v === undefined)
    ? undefined
    : values.reduce<number>((s, v) => s + (v ?? 0), 0);

/**
 * O caminho de um pedido já autenticado e validado:
 * configuração → acesso no StepAccess (conta utilização) → memórias → modelo → validação.
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
  const { result, attempts } = await callModel(deps.llm, tool, prepared);
  const last = attempts[attempts.length - 1];
  const costUsd = sumTokens(attempts.map((a) => a.costUsd));
  if (result === undefined || last === undefined) {
    // As tentativas falhadas também custam: o custo vai no log do erro.
    throw Object.assign(
      new AppError(
        'invalid_model_output',
        502,
        'O modelo de IA devolveu uma resposta inválida. Tente de novo.',
      ),
      { costUsd },
    );
  }
  return {
    result,
    meta: {
      model: last.model,
      attempts: attempts.length,
      inputTokens: sumTokens(attempts.map((a) => a.inputTokens)),
      outputTokens: sumTokens(attempts.map((a) => a.outputTokens)),
      costUsd,
      orgMemories: prepared.memories.org.length,
      userMemories: prepared.memories.user.length,
    },
  };
}
