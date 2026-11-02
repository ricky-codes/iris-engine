import { createHmac } from 'node:crypto';
import type { Alert, AlertSink, DeliveryResult } from '../alerts/types.js';
import type { FetchLike } from './fetch.js';

export interface WebhookAlertSinkConfig {
  url: string;
  /** Segredo da assinatura HMAC (cabeçalho `X-Iris-Signature`). */
  secret: string;
  /** `iris`: o alerta em JSON · `slack`: `{ text }` com título e resumo. */
  format: 'iris' | 'slack';
}

const TIMEOUT_MS = 5000;
/** Espera antes de cada nova tentativa: 1 envio + 3 novas tentativas. */
export const RETRY_DELAYS_MS = [1000, 4000, 10_000];

/** `sha256=<hmac>` do corpo, para o destino confirmar que o alerta veio da IRIS. */
export function signature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** O corpo no formato do Slack (incoming webhook): só texto. */
export function slackBody(alert: Alert): { text: string } {
  const state =
    alert.state === 'resolved' ? 'Resolvido' : alert.severity === 'error' ? 'Erro' : 'Aviso';
  const link = alert.consoleUrl === undefined ? '' : `\n<${alert.consoleUrl}|Abrir a consola>`;
  return { text: `*[${state}] ${alert.title}*\n${alert.summary}${link}` };
}

/**
 * Envia cada alerta por POST JSON, assinado. Tenta até 4 vezes (5 s cada) em falhas de rede,
 * 429 e 5xx; um 4xx não melhora ao repetir. Nunca lança: o resultado diz como correu.
 */
export class WebhookAlertSink implements AlertSink {
  readonly configured = true;

  constructor(
    private readonly config: WebhookAlertSinkConfig,
    private readonly fetchFn: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async send(alert: Alert): Promise<DeliveryResult> {
    const body = JSON.stringify(this.config.format === 'slack' ? slackBody(alert) : alert);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'iris-engine',
      'X-Iris-Signature': signature(body, this.config.secret),
    };
    const started = this.now();
    let status: number | null = null;
    let error: string | null = null;
    let attempts = 0;

    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      if (i > 0) await this.sleep(RETRY_DELAYS_MS[i - 1] ?? 0);
      attempts++;
      try {
        const res = await this.fetchFn(this.config.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        // O corpo da resposta não interessa e nunca é guardado.
        await res.body?.cancel().catch(() => undefined);
        if (res.ok)
          return {
            delivered: true,
            status,
            durationMs: this.now() - started,
            attempts,
            error: null,
          };
        error = `HTTP ${String(res.status)}`;
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        status = null;
        error = err instanceof Error ? err.name : 'erro';
      }
    }
    return { delivered: false, status, durationMs: this.now() - started, attempts, error };
  }
}

/** Sem webhook configurado: os alertas são calculados e ficam na API, mas não saem. */
export class NoopAlertSink implements AlertSink {
  readonly configured = false;

  async send(): Promise<DeliveryResult> {
    return {
      delivered: false,
      status: null,
      durationMs: 0,
      attempts: 0,
      error: 'ALERT_WEBHOOK_URL não configurado',
    };
  }
}
