import { Value } from '@sinclair/typebox/value';
import { AppError } from '../http/errors.js';
import type { AccessChecker } from './access.js';
import type { LlmProvider } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import type { EngineStore } from './store.js';
import type { ToolDefinition } from './tool.js';

export interface EngineDeps {
  access: AccessChecker;
  store: EngineStore;
  llm: LlmProvider;
  defaultModel: string;
}

export interface RunResult {
  result: unknown;
  /** Só metadados, para os logs. Nunca conteúdo. */
  meta: {
    model: string;
    attempts: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
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
 * O caminho de um pedido já autenticado e validado:
 * configuração → acesso no StepAccess (conta utilização) → memórias → modelo → validação.
 * Nada é guardado.
 */
export async function runTool(
  deps: EngineDeps,
  tool: ToolDefinition,
  request: { orgId: string; userId: string; input: Record<string, unknown> },
): Promise<RunResult> {
  const settings = await deps.store.settingsFor(tool.name, tool.defaults, deps.defaultModel);
  if (!settings.enabled) {
    throw new AppError('service_unavailable', 503, 'Esta ferramenta está desativada.');
  }

  await deps.access.check({ orgId: request.orgId, userId: request.userId });

  const memories = await deps.store.memoriesFor({
    orgId: request.orgId,
    userId: request.userId,
    tool: tool.name,
  });
  const system = buildSystemPrompt(settings.systemPrompt ?? tool.systemPrompt, memories);
  const user = tool.buildUserMessage(request.input);
  // Cópia sem os símbolos internos do TypeBox: é o JSON Schema que vai para o fornecedor.
  const schema = JSON.parse(JSON.stringify(tool.output)) as Record<string, unknown>;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await deps.llm.complete({
      model: settings.model,
      system,
      user,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
      output: { name: `${tool.name}_result`, schema },
    });
    const parsed = parseModelJson(response.text);
    if (parsed !== undefined && Value.Check(tool.output, parsed)) {
      return {
        result: parsed,
        meta: {
          model: response.model,
          attempts: attempt,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          orgMemories: memories.org.length,
          userMemories: memories.user.length,
        },
      };
    }
  }
  throw new AppError(
    'invalid_model_output',
    502,
    'O modelo de IA devolveu uma resposta inválida. Tente de novo.',
  );
}
