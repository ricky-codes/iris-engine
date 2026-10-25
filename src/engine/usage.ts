import type { StepAccessConfig } from '../config.js';
import type { FetchLike } from './access.js';

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

const RETRY_DELAY_MS = 1000;

/**
 * Envia o custo ao StepAccess (`POST /v1/usage/cost`) depois de responder ao Salesforce.
 * Tenta duas vezes; se não conseguir, escreve o evento completo no log para se poder
 * reenviar à mão. O `requestId` permite ao StepAccess ignorar repetidos.
 */
export class StepAccessUsageReporter implements UsageReporter {
  constructor(
    private readonly config: StepAccessConfig,
    private readonly fetchFn: FetchLike = fetch,
    private readonly log: (msg: string, data: Record<string, unknown>) => void = () => undefined,
    private readonly retryDelayMs = RETRY_DELAY_MS,
  ) {}

  report(event: CostEvent): void {
    void this.send(event);
  }

  /** Devolve `true` se o StepAccess aceitou. Exposto para os testes. */
  async send(event: CostEvent): Promise<boolean> {
    const body = JSON.stringify({
      componentUuid: this.config.componentUuid,
      ...event,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      costUsd: event.costUsd ?? null,
    });
    const basic = Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64');

    let lastStatus: number | string = 'sem resposta';
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      try {
        const res = await this.fetchFn(`${this.config.url}/v1/usage/cost`, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        // 409: já registado (repetido). Conta como entregue.
        if (res.ok || res.status === 409) return true;
        lastStatus = res.status;
        // Um 4xx não melhora ao repetir.
        if (res.status < 500) break;
      } catch (err) {
        lastStatus = err instanceof Error ? err.name : String(err);
      }
    }
    this.log('stepaccess cost not reported', { status: lastStatus, event });
    return false;
  }
}
