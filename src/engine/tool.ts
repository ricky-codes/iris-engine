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
  /**
   * Só as ferramentas cuja resposta tem um campo de texto livre podem ir em streaming. `field` é
   * esse campo (uma propriedade de texto de `output`): chega ao cliente à medida que o modelo o
   * escreve, e o JSON completo e validado chega no fim. Sem isto, `stream: true` é recusado.
   */
  stream?: { field: string };
  /** Constrói a mensagem do utilizador a partir da entrada validada. */
  buildUserMessage: (input: Static<I>) => string;
  /**
   * Opcional: transforma a resposta já validada antes de a devolver (limpar o texto, juntar
   * campos que se calculam no código em vez de os pedir ao modelo). O que devolve é o `result`
   * que o cliente recebe, também no fim do streaming.
   */
  finalize?: (output: Static<O>, input: Static<I>, ctx: ToolContext) => Record<string, unknown>;
  /**
   * Opcional: validação que depende do pedido (por exemplo, valores que têm de existir numa lista
   * que vem na entrada). Devolve os problemas encontrados; com algum, a resposta conta como
   * inválida e o motor volta a pedir, dizendo ao modelo o que estava errado. Se nenhuma tentativa
   * passar, devolve-se a última com o formato certo, e o `finalize` tem de retirar o que não vale.
   */
  check?: (output: Static<O>, input: Static<I>) => string[];
  /**
   * Opcional: regras da entrada que o esquema não exprime (por exemplo, referências entre campos).
   * Cada problema dá 422, como um erro de esquema, antes de se contar utilização.
   */
  validateInput?: (input: Static<I>) => { path: string; issue: string }[];
}

/** O que o motor dá às ferramentas no fim de um pedido: as definições que lhes dizem respeito. */
export interface ToolContext {
  /** Confiança mínima (0 a 1) para uma ferramenta marcar um valor como sugerido. */
  suggestThreshold: number;
}

/** Ajuda a manter os tipos de entrada e saída ligados ao definir uma ferramenta. */
export function defineTool<I extends TObject, O extends TObject>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return tool;
}
