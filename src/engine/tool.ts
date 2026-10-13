import type { TObject, Static } from '@sinclair/typebox';

/** Valores por omissão de uma ferramenta. A tabela `tool_config` pode substituí-los. */
export interface ToolDefaults {
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * Uma ferramenta da IRIS. Cada uma é um módulo em `src/tools/` que declara o que recebe,
 * o que devolve e como fala com o modelo. O motor trata do resto: autenticação, acesso
 * no StepAccess, memórias, chamada ao modelo e validação da resposta.
 */
export interface ToolDefinition<I extends TObject = TObject, O extends TObject = TObject> {
  /** Código estável (`^[a-z_]+$`). É o nome na rota: `POST /v1/tools/<name>`. */
  name: string;
  /** Versão do contrato de entrada e saída. Muda quando o contrato muda. */
  version: number;
  description: string;
  /** Campos próprios da ferramenta. `orgId` e `userId` juntam-se sozinhos. */
  input: I;
  /** O JSON que o modelo tem de devolver. Todos os campos obrigatórios, sem campos extra. */
  output: O;
  /** Prompt de sistema de origem. Uma versão ativa na base de dados substitui-o. */
  systemPrompt: string;
  defaults: ToolDefaults;
  /** Constrói a mensagem do utilizador a partir da entrada validada. */
  buildUserMessage: (input: Static<I>) => string;
}

/** Ajuda a manter os tipos de entrada e saída ligados ao definir uma ferramenta. */
export function defineTool<I extends TObject, O extends TObject>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return tool;
}
