/**
 * Contadores agregados dos pedidos às ferramentas, só em memória e desde o arranque.
 * Não guardam ids, orgs, utilizadores nem conteúdo: apenas totais por ferramenta e por dia.
 * Recomeçam do zero quando o serviço reinicia.
 */

export interface ToolCounters {
  requests: number;
  succeeded: number;
  failed: number;
  /** Pedidos falhados por código de erro (ex.: `access_denied`, `quota_exceeded`). */
  errorsByCode: Record<string, number>;
  /** Tempo médio dos pedidos bem-sucedidos, em milissegundos. */
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface MetricsSnapshot {
  since: string;
  totals: ToolCounters;
  byTool: ({ tool: string } & ToolCounters)[];
  /** Últimos dias (UTC), do mais antigo para o mais recente. */
  byDay: ({ day: string } & ToolCounters)[];
}

interface Bucket {
  requests: number;
  succeeded: number;
  failed: number;
  errorsByCode: Map<string, number>;
  successDurationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MetricEvent {
  tool: string;
  /** `undefined` quando o pedido correu bem. */
  errorCode: string | undefined;
  durationMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

const emptyBucket = (): Bucket => ({
  requests: 0,
  succeeded: 0,
  failed: 0,
  errorsByCode: new Map(),
  successDurationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
});

function add(bucket: Bucket, event: MetricEvent): void {
  bucket.requests++;
  if (event.errorCode === undefined) {
    bucket.succeeded++;
    bucket.successDurationMs += event.durationMs;
  } else {
    bucket.failed++;
    bucket.errorsByCode.set(event.errorCode, (bucket.errorsByCode.get(event.errorCode) ?? 0) + 1);
  }
  bucket.inputTokens += event.inputTokens ?? 0;
  bucket.outputTokens += event.outputTokens ?? 0;
}

function merge(target: Bucket, source: Bucket): void {
  target.requests += source.requests;
  target.succeeded += source.succeeded;
  target.failed += source.failed;
  target.successDurationMs += source.successDurationMs;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  for (const [code, n] of source.errorsByCode)
    target.errorsByCode.set(code, (target.errorsByCode.get(code) ?? 0) + n);
}

function view(bucket: Bucket): ToolCounters {
  return {
    requests: bucket.requests,
    succeeded: bucket.succeeded,
    failed: bucket.failed,
    errorsByCode: Object.fromEntries(
      [...bucket.errorsByCode].sort(([a], [b]) => a.localeCompare(b)),
    ),
    avgDurationMs:
      bucket.succeeded === 0 ? null : Math.round(bucket.successDurationMs / bucket.succeeded),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
  };
}

const MAX_DAYS = 30;

export class Metrics {
  private readonly startedAt: Date;
  private readonly byTool = new Map<string, Bucket>();
  private readonly byDay = new Map<string, Bucket>();

  constructor(private readonly clock: () => Date = () => new Date()) {
    this.startedAt = clock();
  }

  record(event: MetricEvent): void {
    let tool = this.byTool.get(event.tool);
    if (tool === undefined) this.byTool.set(event.tool, (tool = emptyBucket()));
    add(tool, event);

    const day = this.clock().toISOString().slice(0, 10);
    let daily = this.byDay.get(day);
    if (daily === undefined) {
      this.byDay.set(day, (daily = emptyBucket()));
      // Só os últimos dias: os mais antigos saem.
      const days = [...this.byDay.keys()].sort();
      for (const old of days.slice(0, Math.max(0, days.length - MAX_DAYS))) this.byDay.delete(old);
    }
    add(daily, event);
  }

  snapshot(): MetricsSnapshot {
    const totals = emptyBucket();
    for (const bucket of this.byTool.values()) merge(totals, bucket);
    return {
      since: this.startedAt.toISOString(),
      totals: view(totals),
      byTool: [...this.byTool]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tool, bucket]) => ({ tool, ...view(bucket) })),
      byDay: [...this.byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, bucket]) => ({ day, ...view(bucket) })),
    };
  }
}
