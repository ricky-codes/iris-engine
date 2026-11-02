/**
 * Alertas: o motor avisa por webhook quando algo fica mal. Um alerta só leva contagens,
 * códigos de erro e nomes de módulos, ferramentas e modelos. Nunca conteúdo, nem ids de
 * org ou de utilizador, nem mensagens dos fornecedores.
 */

export type AlertState = 'firing' | 'resolved';
export type AlertSeverity = 'warning' | 'error';

export interface Alert {
  service: string;
  environment: string;
  /** Estável entre avaliações: identifica a condição (ex.: `tool.reply.failure_rate`). */
  key: string;
  state: AlertState;
  severity: AlertSeverity;
  title: string;
  summary: string;
  /** O módulo da topologia a que o alerta diz respeito, quando há um. */
  nodeId: string | null;
  details: Record<string, number | string | boolean | null | Record<string, number>>;
  startedAt: string;
  sentAt: string;
  consoleUrl?: string;
}

/** O resultado de um envio. Nunca o corpo da resposta do destino. */
export interface DeliveryResult {
  delivered: boolean;
  /** Estado HTTP da última tentativa, ou `null` sem resposta. */
  status: number | null;
  durationMs: number;
  attempts: number;
  /** Porque falhou (ex.: `HTTP 500`, `TimeoutError`); `null` se correu bem. */
  error: string | null;
}

/** Para onde vão os alertas. Nunca lança: uma falha vem no resultado. */
export interface AlertSink {
  /** `true` quando há um destino configurado. */
  readonly configured: boolean;
  send(alert: Alert): Promise<DeliveryResult>;
}
