/** Um pedido ao modelo: prompt de sistema, mensagem do utilizador e o JSON esperado. */
export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Nome do formato de saída (para o fornecedor) e JSON Schema que a resposta tem de cumprir. */
  output: { name: string; schema: Record<string, unknown> };
}

export interface LlmResponse {
  /** O texto devolvido pelo modelo (deve ser JSON). */
  text: string;
  /** O modelo que de facto respondeu. */
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  /** Custo da chamada em dólares (créditos do OpenRouter), quando o fornecedor o indica. */
  costUsd: number | undefined;
}

/** Fornecedor de modelos. Lança `AppError` (`provider_unavailable`, `timeout`) se falhar. */
export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
