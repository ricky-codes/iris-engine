/** O custo de um pedido que chegou ao modelo. Só metadados, nunca conteúdo. */
export interface CostEvent {
  /** Id do pedido na IRIS (o mesmo do cabeçalho `X-Request-Id`). Chave de idempotência. */
  requestId: string;
  orgId: string;
  userId: string;
  tool: string;
  /** `success`: resposta válida; `invalid_model_output`: o modelo falhou o formato nas duas tentativas. */
  outcome: 'success' | 'invalid_model_output';
  model: string;
  attempts: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  /** Custo em dólares, somado de todas as tentativas. `undefined` se o fornecedor não o indicou. */
  costUsd: number | undefined;
  occurredAt: string;
}

/** Envia o custo de cada pedido para quem o soma. Nunca atrasa nem faz falhar o pedido. */
export interface UsageReporter {
  report(event: CostEvent): void;
}
