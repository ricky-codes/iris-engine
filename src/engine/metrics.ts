import {
  PIPELINE_STAGES,
  type FailureReason,
  type PipelineStage,
  type StageTimings,
} from './pipeline.js';
import type { AttemptReason } from './run.js';

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
  /** Pedidos que só tiveram resposta com um modelo de recurso. */
  fallbacks: number;
}

/** Porque falhou (ou foi saltada) uma chamada a um modelo. */
export type ModelFailure = Exclude<AttemptReason, 'ok'>;
const MODEL_FAILURES: ModelFailure[] = [
  'provider_unavailable',
  'timeout',
  'invalid_output',
  'skipped_breaker',
];

/** Chamadas a cada modelo (as tentativas, não os pedidos), desde o arranque. */
export interface ModelCounters {
  model: string;
  /** Chamadas feitas (os saltos do disjuntor não contam). */
  calls: number;
  /** Chamadas sem resposta válida: fornecedor em baixo, tempo esgotado ou resposta inválida. */
  failed: number;
  /** Por motivo; `skipped_breaker` conta as vezes que o modelo foi saltado, sem chamada. */
  failedByReason: Record<ModelFailure, number>;
  avgDurationMs: number | null;
}

/** Um modelo dentro de uma ferramenta. */
export interface ToolModelCounters extends ModelCounters {
  /** Respostas válidas dadas como modelo de recurso. */
  servedAsFallback: number;
}

export interface MetricsSnapshot {
  since: string;
  totals: ToolCounters;
  byTool: ({ tool: string; byModel: ToolModelCounters[] } & ToolCounters & ToolFlow)[];
  /** Últimos dias (UTC), do mais antigo para o mais recente. */
  byDay: ({ day: string } & ToolCounters)[];
  byModel: ModelCounters[];
}

/** Uma chamada a um modelo (ou um salto do disjuntor). Só nomes, o resultado e o tempo. */
export interface ModelCallMetric {
  tool: string;
  model: string;
  reason: AttemptReason;
  fallback: boolean;
  /** Tentativa neste modelo, a começar em 1. */
  attempt: number;
  durationMs: number;
}

/** O que o motor mediu num pedido, para o diagrama da ferramenta. */
export interface RunMetric {
  tool: string;
  timings: StageTimings;
  /** Memórias aplicadas (só nos pedidos que chegaram ao modelo e tiveram resposta). */
  orgMemories?: number;
  userMemories?: number;
  /** `true` quando o pedido passou pela verificação de acesso. */
  checkedAccess: boolean;
  /** O passo em que parou; ausente quando correu bem. */
  stoppedAt?: PipelineStage;
  /** Os modelos chamados, por ordem (para os pares de recurso `de → para`). */
  models?: string[];
}

/** Os contadores de um passo, em `byTool[].stages`. */
export interface StageCounters {
  entered: number;
  passed: number;
  stopped: number;
  /** Paragens pela razão fina do catálogo (ou pelo código, quando não há razão). */
  byCode: Record<string, number>;
  /** Tempo médio no passo, nos pedidos que lá entraram; `null` sem medida. */
  avgMs: number | null;
}

/** Um modelo numa ferramenta, no formato do dashboard (`byTool[].models`). */
export interface FlowModelCounters {
  model: string;
  calls: number;
  failed: number;
  /** Por razão: `provider_error`, `model_timeout`, `invalid_output`, `skipped_breaker`. */
  byCode: Record<string, number>;
  avgMs: number | null;
  p95Ms: number | null;
  /** Vezes que este modelo foi chamado como recurso. */
  fallbackFrom: number;
}

/** O fluxo de uma ferramenta, para animar o diagrama. */
export interface ToolFlow {
  stages: Record<PipelineStage, StageCounters>;
  models: FlowModelCounters[];
  /** Novas tentativas no mesmo modelo depois de uma resposta inválida. */
  retries: number;
  fallbackPairs: { from: string; to: string; count: number }[];
  p50Ms: number | null;
  p95Ms: number | null;
  /** Os últimos 60 minutos (UTC), do mais antigo para o mais recente, só os que tiveram pedidos. */
  recent: { minute: string; requests: number; failed: number }[];
}

/** As últimas N durações, para os percentis (memória fixa). */
class Samples {
  private readonly values: number[] = [];
  private next = 0;
  constructor(private readonly size = 1000) {}
  add(v: number): void {
    if (this.values.length < this.size) this.values.push(v);
    else this.values[this.next] = v;
    this.next = (this.next + 1) % this.size;
  }
  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
  }
}

const ENGINE_STAGES = [
  'gate',
  'rate',
  'access',
  'memories',
  'prompt',
  'models',
  'validate',
] as const;
const CALL_CODE: Record<string, string> = {
  provider_unavailable: 'provider_error',
  timeout: 'model_timeout',
  invalid_output: 'invalid_output',
  skipped_breaker: 'skipped_breaker',
};

interface Flow {
  stageMs: Map<PipelineStage, { sum: number; n: number }>;
  reasonStops: Map<PipelineStage, Map<string, number>>;
  durations: Samples;
  minutes: Map<string, { requests: number; failed: number }>;
  modelDurations: Map<string, Samples>;
  fallbackFrom: Map<string, number>;
  pairs: Map<string, number>;
}

const emptyFlow = (): Flow => ({
  stageMs: new Map(),
  reasonStops: new Map(),
  durations: new Samples(),
  minutes: new Map(),
  modelDurations: new Map(),
  fallbackFrom: new Map(),
  pairs: new Map(),
});

const bump = <K>(map: Map<K, number>, key: K, n = 1): void => {
  map.set(key, (map.get(key) ?? 0) + n);
};

/** O que o diagrama de uma ferramenta precisa, além dos contadores. */
export interface ToolPipelineMetrics {
  counters: ToolCounters;
  /** Pedidos parados em cada passo, por código de erro. */
  stops: Record<PipelineStage, Record<string, number>>;
  byModel: (ToolModelCounters & { retries: number })[];
  memories: { runs: number; orgAvg: number | null; userAvg: number | null };
  /** Duração da última verificação de acesso de um pedido a esta ferramenta. */
  lastAccessMs: number | null;
}

interface ModelBucket {
  calls: number;
  failed: number;
  okDurationMs: number;
  byReason: Map<ModelFailure, number>;
  servedAsFallback: number;
  retries: number;
}

const emptyModel = (): ModelBucket => ({
  calls: 0,
  failed: 0,
  okDurationMs: 0,
  byReason: new Map(),
  servedAsFallback: 0,
  retries: 0,
});

function addCall(m: ModelBucket, call: ModelCallMetric): void {
  if (call.reason === 'skipped_breaker') {
    m.byReason.set('skipped_breaker', (m.byReason.get('skipped_breaker') ?? 0) + 1);
    return;
  }
  m.calls++;
  if (call.attempt > 1) m.retries++;
  if (call.reason === 'ok') {
    m.okDurationMs += call.durationMs;
    if (call.fallback) m.servedAsFallback++;
  } else {
    m.failed++;
    m.byReason.set(call.reason, (m.byReason.get(call.reason) ?? 0) + 1);
  }
}

function modelView(model: string, m: ModelBucket): ModelCounters {
  return {
    model,
    calls: m.calls,
    failed: m.failed,
    failedByReason: Object.fromEntries(
      MODEL_FAILURES.map((r) => [r, m.byReason.get(r) ?? 0]),
    ) as Record<ModelFailure, number>,
    avgDurationMs: m.calls === m.failed ? null : Math.round(m.okDurationMs / (m.calls - m.failed)),
  };
}

const sortedModels = <T>(map: Map<string, ModelBucket>, fn: (model: string, m: ModelBucket) => T) =>
  [...map].sort(([a], [b]) => a.localeCompare(b)).map(([model, m]) => fn(model, m));

interface Bucket {
  requests: number;
  succeeded: number;
  failed: number;
  errorsByCode: Map<string, number>;
  successDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  fallbacks: number;
  stops: Map<PipelineStage, Map<string, number>>;
}

export interface MetricEvent {
  tool: string;
  /** `undefined` quando o pedido correu bem. */
  errorCode: string | undefined;
  /** O passo em que o pedido parou (só nos que falharam). */
  stage?: PipelineStage | undefined;
  /** A razão fina (catálogo de erros); sem ela conta o código. */
  reason?: FailureReason | undefined;
  durationMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** `true` quando a resposta veio de um modelo de recurso. */
  fallback?: boolean | undefined;
}

const emptyBucket = (): Bucket => ({
  requests: 0,
  succeeded: 0,
  failed: 0,
  errorsByCode: new Map(),
  successDurationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  fallbacks: 0,
  stops: new Map(),
});

function add(bucket: Bucket, event: MetricEvent): void {
  bucket.requests++;
  if (event.errorCode === undefined) {
    bucket.succeeded++;
    bucket.successDurationMs += event.durationMs;
  } else {
    bucket.failed++;
    bucket.errorsByCode.set(event.errorCode, (bucket.errorsByCode.get(event.errorCode) ?? 0) + 1);
    const stage = event.stage ?? 'response';
    let codes = bucket.stops.get(stage);
    if (codes === undefined) bucket.stops.set(stage, (codes = new Map<string, number>()));
    codes.set(event.errorCode, (codes.get(event.errorCode) ?? 0) + 1);
  }
  bucket.inputTokens += event.inputTokens ?? 0;
  bucket.outputTokens += event.outputTokens ?? 0;
  if (event.fallback === true && event.errorCode === undefined) bucket.fallbacks++;
}

function merge(target: Bucket, source: Bucket): void {
  target.requests += source.requests;
  target.succeeded += source.succeeded;
  target.failed += source.failed;
  target.successDurationMs += source.successDurationMs;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.fallbacks += source.fallbacks;
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
    fallbacks: bucket.fallbacks,
  };
}

const MAX_DAYS = 30;

export class Metrics {
  private readonly startedAt: Date;
  private readonly byTool = new Map<string, Bucket>();
  private readonly byDay = new Map<string, Bucket>();
  private readonly byModel = new Map<string, ModelBucket>();
  private readonly toolModels = new Map<string, Map<string, ModelBucket>>();
  private readonly flows = new Map<string, Flow>();
  private readonly runs = new Map<
    string,
    { memoryRuns: number; org: number; user: number; lastAccessMs: number | null }
  >();

  constructor(private readonly clock: () => Date = () => new Date()) {
    this.startedAt = clock();
  }

  /** Desde quando se conta (o arranque). */
  get since(): string {
    return this.startedAt.toISOString();
  }

  private flow(tool: string): Flow {
    let f = this.flows.get(tool);
    if (f === undefined) this.flows.set(tool, (f = emptyFlow()));
    return f;
  }

  record(event: MetricEvent): void {
    let tool = this.byTool.get(event.tool);
    if (tool === undefined) this.byTool.set(event.tool, (tool = emptyBucket()));
    add(tool, event);

    const f = this.flow(event.tool);
    f.durations.add(event.durationMs);
    if (event.errorCode !== undefined) {
      const stage = event.stage ?? 'response';
      let codes = f.reasonStops.get(stage);
      if (codes === undefined) f.reasonStops.set(stage, (codes = new Map<string, number>()));
      bump(codes, event.reason ?? event.errorCode);
    }
    const minute = this.clock().toISOString().slice(0, 16);
    const m = f.minutes.get(minute) ?? { requests: 0, failed: 0 };
    m.requests++;
    if (event.errorCode !== undefined) m.failed++;
    f.minutes.set(minute, m);
    // Só os últimos 60 minutos.
    if (f.minutes.size > 61) {
      const cutoff = new Date(this.clock().getTime() - 60 * 60_000).toISOString().slice(0, 16);
      for (const key of f.minutes.keys()) if (key <= cutoff) f.minutes.delete(key);
    }

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

  recordModelCall(call: ModelCallMetric): void {
    let m = this.byModel.get(call.model);
    if (m === undefined) this.byModel.set(call.model, (m = emptyModel()));
    addCall(m, call);
    let models = this.toolModels.get(call.tool);
    if (models === undefined)
      this.toolModels.set(call.tool, (models = new Map<string, ModelBucket>()));
    let t = models.get(call.model);
    if (t === undefined) models.set(call.model, (t = emptyModel()));
    addCall(t, call);
    if (call.reason === 'skipped_breaker') return;
    const f = this.flow(call.tool);
    let samples = f.modelDurations.get(call.model);
    if (samples === undefined) f.modelDurations.set(call.model, (samples = new Samples(500)));
    samples.add(call.durationMs);
    if (call.fallback && call.attempt === 1) bump(f.fallbackFrom, call.model);
  }

  recordRun(run: RunMetric): void {
    let r = this.runs.get(run.tool);
    if (r === undefined)
      this.runs.set(run.tool, (r = { memoryRuns: 0, org: 0, user: 0, lastAccessMs: null }));
    if (run.checkedAccess) r.lastAccessMs = run.timings.access;
    if (run.orgMemories !== undefined && run.userMemories !== undefined) {
      r.memoryRuns++;
      r.org += run.orgMemories;
      r.user += run.userMemories;
    }
    const f = this.flow(run.tool);
    // Os passos em que o pedido entrou: todos até ao que o parou.
    const stop = run.stoppedAt;
    const last =
      stop === undefined || stop === 'response'
        ? ENGINE_STAGES.length
        : stop === 'request' || stop === 'auth'
          ? -1
          : ENGINE_STAGES.indexOf(stop);
    ENGINE_STAGES.forEach((stage, i) => {
      if (i > last) return;
      if (stage === 'access' && !run.checkedAccess) return;
      const t = f.stageMs.get(stage) ?? { sum: 0, n: 0 };
      t.sum += run.timings[stage];
      t.n++;
      f.stageMs.set(stage, t);
    });
    const chain = run.models ?? [];
    for (let i = 1; i < chain.length; i++) {
      const from = chain[i - 1];
      const to = chain[i];
      if (from !== undefined && to !== undefined && from !== to)
        bump(f.pairs, `${from}\u0000${to}`);
    }
  }

  /** O fluxo de uma ferramenta: passos, modelos, percentis e os últimos 60 minutos. */
  flowOf(tool: string): ToolFlow {
    const bucket = this.byTool.get(tool) ?? emptyBucket();
    const f = this.flows.get(tool) ?? emptyFlow();
    let entered = bucket.requests;
    const stages = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => {
        const codes = f.reasonStops.get(stage) ?? new Map<string, number>();
        const stopped = [...codes.values()].reduce((a, b) => a + b, 0);
        const t = f.stageMs.get(stage);
        const c: StageCounters = {
          entered,
          passed: Math.max(0, entered - stopped),
          stopped,
          byCode: Object.fromEntries([...codes].sort(([a], [b]) => a.localeCompare(b))),
          avgMs: t === undefined || t.n === 0 ? null : Math.round(t.sum / t.n),
        };
        entered = c.passed;
        return [stage, c];
      }),
    ) as Record<PipelineStage, StageCounters>;
    const models = sortedModels(
      this.toolModels.get(tool) ?? new Map<string, ModelBucket>(),
      (model, m): FlowModelCounters => {
        const v = modelView(model, m);
        return {
          model,
          calls: v.calls,
          failed: v.failed,
          byCode: Object.fromEntries(
            Object.entries(v.failedByReason).map(([k, n]) => [CALL_CODE[k] ?? k, n]),
          ),
          avgMs: v.avgDurationMs,
          p95Ms: f.modelDurations.get(model)?.percentile(95) ?? null,
          fallbackFrom: f.fallbackFrom.get(model) ?? 0,
        };
      },
    );
    const cutoff = new Date(this.clock().getTime() - 60 * 60_000).toISOString().slice(0, 16);
    return {
      stages,
      models,
      retries: [...(this.toolModels.get(tool)?.values() ?? [])].reduce((n, m) => n + m.retries, 0),
      fallbackPairs: [...f.pairs]
        .map(([key, count]) => {
          const [from = '', to = ''] = key.split('\u0000');
          return { from, to, count };
        })
        .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
      p50Ms: f.durations.percentile(50),
      p95Ms: f.durations.percentile(95),
      recent: [...f.minutes]
        .filter(([minute]) => minute > cutoff)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([minute, m]) => ({ minute: `${minute}:00.000Z`, ...m })),
    };
  }

  /** O que o diagrama da ferramenta mostra: contadores, paragens por passo e modelos. */
  pipeline(tool: string): ToolPipelineMetrics {
    const bucket = this.byTool.get(tool) ?? emptyBucket();
    const r = this.runs.get(tool);
    const avg = (sum: number): number | null =>
      r === undefined || r.memoryRuns === 0 ? null : Math.round((sum / r.memoryRuns) * 10) / 10;
    return {
      counters: view(bucket),
      stops: Object.fromEntries(
        PIPELINE_STAGES.map((stage) => [
          stage,
          Object.fromEntries(
            [...(bucket.stops.get(stage) ?? new Map<string, number>())].sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        ]),
      ) as Record<PipelineStage, Record<string, number>>,
      byModel: sortedModels(
        this.toolModels.get(tool) ?? new Map<string, ModelBucket>(),
        (model, m) => ({
          ...modelView(model, m),
          servedAsFallback: m.servedAsFallback,
          retries: m.retries,
        }),
      ),
      memories: { runs: r?.memoryRuns ?? 0, orgAvg: avg(r?.org ?? 0), userAvg: avg(r?.user ?? 0) },
      lastAccessMs: r?.lastAccessMs ?? null,
    };
  }

  snapshot(): MetricsSnapshot {
    const totals = emptyBucket();
    for (const bucket of this.byTool.values()) merge(totals, bucket);
    return {
      since: this.startedAt.toISOString(),
      totals: view(totals),
      byTool: [...this.byTool]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tool, bucket]) => ({
          tool,
          ...view(bucket),
          byModel: sortedModels(
            this.toolModels.get(tool) ?? new Map<string, ModelBucket>(),
            (model, m) => ({
              ...modelView(model, m),
              servedAsFallback: m.servedAsFallback,
            }),
          ),
          ...this.flowOf(tool),
        })),
      byDay: [...this.byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, bucket]) => ({ day, ...view(bucket) })),
      byModel: sortedModels(this.byModel, modelView),
    };
  }
}
