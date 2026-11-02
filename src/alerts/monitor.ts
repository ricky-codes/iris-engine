import type { BreakerFact, Topology } from '../admin/topology.js';
import type { MetricsSnapshot } from '../engine/metrics.js';
import { evaluateRules, type Condition } from './rules.js';
import type { Alert, AlertSink, DeliveryResult } from './types.js';
import { MetricsWindow } from './window.js';

/** O estado dos alertas, para o `/status` e a topologia. */
export interface AlertsFacts {
  configured: boolean;
  format: 'iris' | 'slack' | null;
  active: number;
  lastSentAt: string | null;
  lastError: string | null;
}

/** Só uma instância avalia e envia (ver `PgLeaderLock`). */
export interface LeaderLock {
  acquire(): Promise<boolean>;
}

export interface AlertMonitorOptions {
  sink: AlertSink;
  format: 'iris' | 'slack' | null;
  /** A topologia atual (já inclui as verificações do `/status`). */
  topology: () => Promise<Topology>;
  metrics: { snapshot(): MetricsSnapshot };
  breakers: () => BreakerFact[];
  service: { name: string; environment: string };
  consoleUrl?: string | undefined;
  windowMs: number;
  repeatMs: number;
  now?: () => number;
  leader?: LeaderLock | undefined;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

interface Active {
  alert: Alert;
  lastSentAt: number;
  /** Avaliações seguidas sem a condição. */
  clearStreak: number;
}

/** Quantas avaliações seguidas sem a condição até enviar `resolved` (evita oscilar). */
export const RESOLVE_AFTER = 2;
const RECENT = 100;

/**
 * Avalia as regras em intervalo e envia os alertas: só na passagem a um estado mau, um lembrete
 * a cada `repeatMs` enquanto se mantém, e `resolved` quando a condição desaparece em duas
 * avaliações seguidas. O estado vive em memória. Os envios nunca bloqueiam os pedidos.
 */
export class AlertMonitor {
  private readonly active = new Map<string, Active>();
  private readonly recent: Alert[] = [];
  private readonly window: MetricsWindow;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly opts: AlertMonitorOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.window = new MetricsWindow(opts.windowMs);
  }

  facts(): AlertsFacts {
    return {
      configured: this.opts.sink.configured,
      format: this.opts.sink.configured ? this.opts.format : null,
      active: this.active.size,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    };
  }

  view(): { configured: boolean; active: Alert[]; recent: Alert[] } {
    return {
      configured: this.opts.sink.configured,
      active: [...this.active.values()]
        .map((a) => a.alert)
        .sort((a, b) => a.key.localeCompare(b.key)),
      recent: [...this.recent].reverse(),
    };
  }

  /** Uma avaliação. Devolve `false` se esta instância não é a que avalia. */
  async evaluate(): Promise<boolean> {
    if (this.opts.leader !== undefined && !(await this.opts.leader.acquire())) return false;
    const now = this.now();
    this.window.push(now, this.opts.metrics.snapshot());
    let topology: Topology;
    try {
      topology = await this.opts.topology();
    } catch (err) {
      this.opts.log?.('alerts evaluation failed', {
        err: err instanceof Error ? err.name : 'erro',
      });
      return true;
    }
    const conditions = evaluateRules({
      topology,
      window: this.window.delta(),
      windowMs: this.opts.windowMs,
      breakers: this.opts.breakers(),
      now,
    });
    this.apply(conditions, now);
    return true;
  }

  private apply(conditions: Condition[], now: number): void {
    const seen = new Set<string>();
    for (const c of conditions) {
      seen.add(c.key);
      const current = this.active.get(c.key);
      if (current === undefined) {
        const alert = this.build(c, 'firing', new Date(now).toISOString(), now);
        this.active.set(c.key, { alert, lastSentAt: now, clearStreak: 0 });
        this.dispatch(alert);
        continue;
      }
      current.clearStreak = 0;
      const changed = current.alert.severity !== c.severity;
      if (changed || now - current.lastSentAt >= this.opts.repeatMs) {
        // Mudou de gravidade, ou é o lembrete periódico.
        current.alert = this.build(c, 'firing', current.alert.startedAt, now);
        current.lastSentAt = now;
        this.dispatch(current.alert);
      } else {
        // Mantém o texto atualizado na API, sem enviar.
        current.alert = {
          ...this.build(c, 'firing', current.alert.startedAt, now),
          sentAt: current.alert.sentAt,
        };
      }
    }
    for (const [key, current] of this.active) {
      if (seen.has(key)) continue;
      current.clearStreak++;
      if (current.clearStreak < RESOLVE_AFTER) continue;
      this.active.delete(key);
      this.dispatch({ ...current.alert, state: 'resolved', sentAt: new Date(now).toISOString() });
    }
  }

  private build(c: Condition, state: Alert['state'], startedAt: string, now: number): Alert {
    return {
      service: this.opts.service.name,
      environment: this.opts.service.environment,
      key: c.key,
      state,
      severity: c.severity,
      title: c.title,
      summary: c.summary,
      nodeId: c.nodeId,
      details: c.details,
      startedAt,
      sentAt: new Date(now).toISOString(),
      ...(this.opts.consoleUrl !== undefined && { consoleUrl: this.opts.consoleUrl }),
    };
  }

  /** Envia em segundo plano: a avaliação não espera pelo webhook. */
  private dispatch(alert: Alert): void {
    this.remember(alert);
    const p = this.deliver(alert).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async deliver(alert: Alert): Promise<DeliveryResult> {
    const result = await this.opts.sink.send(alert).catch((err: unknown): DeliveryResult => ({
      delivered: false,
      status: null,
      durationMs: 0,
      attempts: 0,
      error: err instanceof Error ? err.name : 'erro',
    }));
    if (!this.opts.sink.configured) return result;
    if (result.delivered) {
      this.lastSentAt = new Date(this.now()).toISOString();
      this.lastError = null;
    } else {
      this.lastError = result.error;
      this.opts.log?.('alert not delivered', {
        key: alert.key,
        state: alert.state,
        status: result.status,
        error: result.error,
        attempts: result.attempts,
      });
    }
    return result;
  }

  private remember(alert: Alert): void {
    this.recent.push(alert);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  /** Envia já um alerta de teste e espera pelo resultado. */
  async sendTest(): Promise<DeliveryResult> {
    const now = new Date(this.now()).toISOString();
    const alert: Alert = {
      service: this.opts.service.name,
      environment: this.opts.service.environment,
      key: 'test',
      state: 'firing',
      severity: 'warning',
      title: 'Alerta de teste da IRIS',
      summary: 'Se está a ler isto, os alertas da IRIS chegam a este destino.',
      nodeId: null,
      details: {},
      startedAt: now,
      sentAt: now,
      ...(this.opts.consoleUrl !== undefined && { consoleUrl: this.opts.consoleUrl }),
    };
    this.remember(alert);
    return this.deliver(alert);
  }

  /** Espera pelos envios em curso (para os testes e para o encerramento). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.evaluate()
        .catch((err: unknown) => {
          this.opts.log?.('alerts evaluation failed', {
            err: err instanceof Error ? err.name : 'erro',
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
