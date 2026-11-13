import type { BreakerState, BreakerStatus } from '../engine/breaker.js';
import type { ModelFailure, ToolPipelineMetrics } from '../engine/metrics.js';
import { PIPELINE_STAGES, type PipelineStage } from '../engine/pipeline.js';
import type { ToolOverrides } from '../engine/store.js';
import { ERROR_CATALOG } from './error-catalog.js';
import type { NodeStatus, Topology } from './topology.js';

/**
 * O caminho de um pedido a uma ferramenta, pela ordem do código (`src/engine/pipeline.ts`), com o
 * estado de cada passo, o que o controla e as contagens desde o arranque. Função pura: o servidor
 * junta os factos (configuração, métricas, topologia, disjuntores) e esta função descreve-os.
 * Nunca inclui segredos, ids de org ou de utilizador, nem conteúdo de pedidos.
 */

export type Scalar = string | number | boolean | null;

/** O tipo de passo, para o dashboard escolher o desenho. */
export type StageKind =
  | 'auth'
  | 'request'
  | 'gate'
  | 'rate'
  | 'access'
  | 'memories'
  | 'prompt'
  | 'model'
  | 'validate'
  | 'response';

export interface PipelineStageView {
  id: PipelineStage;
  label: string;
  kind: StageKind;
  /** As saídas possíveis neste passo (catálogo `GET /v1/admin/errors`). */
  exits: { code: string; httpStatus: number; label: string }[];
  status: NodeStatus;
  summary: string;
  /** Pedidos que passaram e que pararam neste passo, desde o arranque. */
  counts: { passed: number; stopped: number };
  stoppedByCode: Record<string, number>;
  /** Campos de `PUT /v1/admin/tools/:name/config` que o controlam. */
  toolConfig: string[];
  /** Chaves de `/v1/admin/settings` (globais) que o controlam. */
  settings: string[];
  /** Chaves que esta ferramenta pode substituir. */
  overrides: (keyof ToolOverrides)[];
  /** Variáveis só do `.env` que o afetam (só os nomes). */
  env: string[];
  details: Record<string, Scalar>;
}

export interface PipelineModelView {
  model: string;
  role: 'primary' | 'fallback';
  breaker: { state: BreakerState; openUntil: string | null; consecutiveFailures: number };
  calls: number;
  succeeded: number;
  avgDurationMs: number | null;
  failedByReason: Record<ModelFailure, number>;
  servedAsFallback: number;
}

export interface Pipeline {
  tool: string;
  generatedAt: string;
  since: string;
  stages: PipelineStageView[];
  models: PipelineModelView[];
  /** A cadeia no formato curto do dashboard. */
  modelChain: {
    model: string;
    role: 'primary' | 'fallback';
    order: number;
    breaker: BreakerState;
    openedAt?: string;
    reopensAt?: string;
  }[];
}

type Resolved = {
  [K in keyof ToolOverrides]: { value: NonNullable<ToolOverrides[K]>; source: 'tool' | 'engine' };
};

export interface PipelineInput {
  tool: string;
  /** Há código para a ferramenta neste servidor. */
  implemented: boolean;
  enabled: boolean;
  /** A ferramenta declara um campo para streaming. */
  streamSupported: boolean;
  /** O modelo principal e os de recurso em vigor; `null` sem modelo (sem código nem configuração). */
  model: string | null;
  fallbackModels: string[];
  prompt: { source: 'database' | 'code' | 'none'; activeVersion: number | null };
  overrides: Resolved;
  since: string;
  metrics: ToolPipelineMetrics;
  breakers: BreakerStatus[];
  topology: Topology;
}

/** O que controla cada passo. Fixo: segue o código. */
const CONTROLS: Record<
  PipelineStage,
  {
    label: string;
    toolConfig: string[];
    settings: string[];
    overrides: (keyof ToolOverrides)[];
    env: string[];
  }
> = {
  auth: {
    label: 'Token',
    toolConfig: [],
    settings: [],
    overrides: [],
    env: ['AUTH_MODE', 'ORG_KEY_ENCRYPTION_KEY', 'API_SECRET'],
  },
  request: {
    label: 'Pedido',
    toolConfig: [],
    settings: [],
    overrides: [],
    env: ['MAX_BODY_BYTES'],
  },
  gate: { label: 'Ligada', toolConfig: ['enabled'], settings: [], overrides: [], env: [] },
  rate: {
    label: 'Limite de pedidos',
    toolConfig: [],
    settings: ['rateLimitPerMinute'],
    overrides: ['rateLimitPerMinute'],
    env: [],
  },
  access: {
    label: 'Acesso',
    toolConfig: [],
    settings: ['stepAccessTimeoutMs'],
    overrides: [],
    env: [
      'ACCESS_MODE',
      'STEPACCESS_URL',
      'STEPACCESS_USER',
      'STEPACCESS_PASSWORD',
      'STEPACCESS_COMPONENT_UUID',
      'STEPACCESS_BYPASS',
    ],
  },
  memories: {
    label: 'Memórias',
    toolConfig: [],
    settings: ['memoryMaxChars', 'memoryPerOrg', 'memoryPerUser'],
    overrides: [],
    env: [],
  },
  prompt: { label: 'Prompt', toolConfig: [], settings: [], overrides: [], env: [] },
  models: {
    label: 'Cadeia de modelos',
    toolConfig: ['model', 'fallbackModels', 'temperature', 'maxOutputTokens', 'timeoutMs'],
    settings: [
      'defaultModel',
      'fallbackModels',
      'totalTimeoutMs',
      'breakerThreshold',
      'breakerOpenMs',
    ],
    overrides: ['totalTimeoutMs'],
    env: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'],
  },
  validate: {
    label: 'Validação',
    toolConfig: [],
    settings: ['maxAttempts'],
    overrides: ['maxAttempts'],
    env: [],
  },
  response: {
    label: 'Resposta',
    toolConfig: [],
    settings: ['streamEnabled', 'stepAccessUsageTimeoutMs'],
    overrides: ['streamEnabled'],
    env: [],
  },
};

/** Pelo menos 5 casos e 20% deles: o mesmo limiar da topologia. */
const tooMany = (part: number, whole: number): boolean => whole >= 5 && part / whole >= 0.2;

const sum = (values: Record<string, number>): number =>
  Object.values(values).reduce((a, b) => a + b, 0);

const shortModel = (m: string): string => m.slice(m.indexOf('/') + 1);

export function buildPipeline(input: PipelineInput, now: Date = new Date()): Pipeline {
  const { metrics, overrides: o } = input;
  const node = (id: string) => input.topology.nodes.find((n) => n.id === id);
  const off = !input.implemented;

  // Os que chegaram a cada passo: os pedidos menos os que pararam nos passos anteriores.
  let reached = metrics.counters.requests;
  const counts = Object.fromEntries(
    PIPELINE_STAGES.map((stage) => {
      const stopped = sum(metrics.stops[stage]);
      const passed = Math.max(0, reached - stopped);
      const c = { reached, passed, stopped };
      reached = passed;
      return [stage, c];
    }),
  ) as Record<PipelineStage, { reached: number; passed: number; stopped: number }>;

  const chain = input.model === null ? [] : [input.model, ...input.fallbackModels];
  const breakerOf = (model: string) => input.breakers.find((b) => b.model === model);
  const openInChain = chain.filter((m) => breakerOf(m)?.state === 'open');
  const modelCalls = metrics.byModel.filter((m) => chain.includes(m.model));
  const invalidOutputs = modelCalls.reduce((n, m) => n + m.failedByReason.invalid_output, 0);
  const calls = modelCalls.reduce((n, m) => n + m.calls, 0);
  const retries = modelCalls.reduce((n, m) => n + m.retries, 0);
  const access = node('adapter.access');
  const mode = access?.details['mode'] ?? null;
  const stream = input.streamSupported && o.streamEnabled.value;

  const describe = (
    stage: PipelineStage,
  ): { status: NodeStatus; summary: string; details: Record<string, Scalar> } => {
    const c = counts[stage];
    switch (stage) {
      case 'auth': {
        const keys = node('core.orgKeys');
        const mode = keys?.details['mode'] ?? 'shared_secret';
        const status = keys?.status ?? 'off';
        return {
          status: tooMany(c.stopped, c.reached) && status === 'ok' ? 'warning' : status,
          summary:
            mode === 'token'
              ? (keys?.summary ?? 'Token da org (JWT HS256)')
              : 'Segredo partilhado (API_SECRET): o orgId e o userId vêm no pedido',
          details: {
            mode: typeof mode === 'string' ? mode : null,
            activeKeys: keys?.details['activeKeys'] ?? null,
            maxTokenTtlSeconds: mode === 'token' ? 300 : null,
          },
        };
      }
      case 'request':
        return { status: 'ok', summary: 'Corpo e entrada da ferramenta validados', details: {} };
      case 'gate':
        return input.enabled
          ? {
              status: 'ok',
              summary:
                input.streamSupported && !o.streamEnabled.value
                  ? 'Aceita pedidos · streaming desligado'
                  : 'Aceita pedidos',
              details: { enabled: true, streamSupported: input.streamSupported },
            }
          : {
              status: 'off',
              summary: 'Desligada: os pedidos dão 503 tool_disabled',
              details: { enabled: false, streamSupported: input.streamSupported },
            };
      case 'rate': {
        const limit = o.rateLimitPerMinute.value;
        return {
          status: tooMany(c.stopped, c.reached) ? 'warning' : 'ok',
          summary:
            limit === 0
              ? 'Sem limite'
              : `${String(limit)} pedidos por minuto ${o.rateLimitPerMinute.source === 'tool' ? 'por org nesta ferramenta' : 'por org (partilhado)'}`,
          details: { limitPerMinute: limit, source: o.rateLimitPerMinute.source },
        };
      }
      case 'access':
        return {
          status: access?.status ?? 'off',
          summary: access?.summary ?? 'Sem verificação de acesso',
          details: {
            mode: typeof mode === 'string' ? mode : null,
            latencyMs: metrics.lastAccessMs,
          },
        };
      case 'memories': {
        const m = metrics.memories;
        return {
          status: node('adapter.pgMemoryStore')?.status ?? 'off',
          summary:
            m.orgAvg === null || m.userAvg === null
              ? 'Ainda sem pedidos com resposta'
              : `Em média ${String(m.orgAvg)} da org e ${String(m.userAvg)} do utilizador por pedido`,
          details: { orgAvg: m.orgAvg, userAvg: m.userAvg, runs: m.runs },
        };
      }
      case 'prompt':
        return {
          status: input.prompt.source === 'none' ? 'off' : 'ok',
          summary:
            input.prompt.source === 'database'
              ? `Base de dados, versão ${String(input.prompt.activeVersion)}`
              : input.prompt.source === 'code'
                ? 'O prompt do código'
                : 'Sem prompt',
          details: { source: input.prompt.source, activeVersion: input.prompt.activeVersion },
        };
      case 'models': {
        const llm = node('adapter.llm');
        const allOpen = chain.length > 0 && openInChain.length === chain.length;
        return {
          status:
            chain.length === 0
              ? 'off'
              : llm?.status === 'error' || allOpen
                ? 'error'
                : openInChain.length > 0 || llm?.status === 'warning'
                  ? 'warning'
                  : (llm?.status ?? 'off'),
          summary:
            chain.length === 0
              ? 'Sem modelo'
              : openInChain.length > 0
                ? `Disjuntor aberto: ${openInChain.map(shortModel).join(', ')}`
                : chain.map(shortModel).join(' → '),
          details: {
            primary: input.model,
            fallbacks: input.fallbackModels.length,
            openBreakers: openInChain.length,
            totalTimeoutMs: o.totalTimeoutMs.value,
            totalTimeoutSource: o.totalTimeoutMs.source,
          },
        };
      }
      case 'validate':
        return {
          status: tooMany(invalidOutputs, calls) ? 'warning' : 'ok',
          summary:
            invalidOutputs === 0
              ? 'Todas as respostas cumpriram o esquema'
              : `${String(invalidOutputs)} resposta(s) inválida(s) em ${String(calls)} chamada(s)`,
          details: {
            invalidOutputs,
            retries,
            maxAttempts: o.maxAttempts.value,
            maxAttemptsSource: o.maxAttempts.source,
          },
        };
      case 'response': {
        const { succeeded, avgDurationMs, requests, failed } = metrics.counters;
        return {
          status: tooMany(failed, requests) ? 'warning' : 'ok',
          summary:
            avgDurationMs === null
              ? 'Ainda sem respostas'
              : `${String(succeeded)} resposta(s) · ${String(avgDurationMs)} ms em média${stream ? ' · streaming' : ''}`,
          details: {
            succeeded,
            avgDurationMs,
            stream,
            streamSource: o.streamEnabled.source,
          },
        };
      }
    }
  };

  const stages = PIPELINE_STAGES.map((id): PipelineStageView => {
    const d = describe(id);
    const { label, ...controls } = CONTROLS[id];
    return {
      id,
      label,
      kind: id === 'models' ? 'model' : id,
      exits: ERROR_CATALOG.filter((e) => e.stage === id).map(({ code, httpStatus, label: l }) => ({
        code,
        httpStatus,
        label: l,
      })),
      status: off ? 'off' : d.status,
      summary: off ? 'Sem implementação neste servidor' : d.summary,
      counts: { passed: counts[id].passed, stopped: counts[id].stopped },
      stoppedByCode: metrics.stops[id],
      ...controls,
      details: d.details,
    };
  });

  const models = chain.map((model, index): PipelineModelView => {
    const b = breakerOf(model);
    const m = metrics.byModel.find((x) => x.model === model);
    return {
      model,
      role: index === 0 ? 'primary' : 'fallback',
      breaker: {
        state: b?.state ?? 'closed',
        openUntil: b?.openUntil ?? null,
        consecutiveFailures: b?.consecutiveFailures ?? 0,
      },
      calls: m?.calls ?? 0,
      succeeded: (m?.calls ?? 0) - (m?.failed ?? 0),
      avgDurationMs: m?.avgDurationMs ?? null,
      failedByReason: m?.failedByReason ?? {
        provider_unavailable: 0,
        timeout: 0,
        invalid_output: 0,
        skipped_breaker: 0,
      },
      servedAsFallback: m?.servedAsFallback ?? 0,
    };
  });

  const modelChain = chain.map((model, order) => {
    const b = breakerOf(model);
    return {
      model,
      role: order === 0 ? ('primary' as const) : ('fallback' as const),
      order,
      breaker: b?.state ?? 'closed',
      ...(b?.openedAt != null && { openedAt: b.openedAt }),
      ...(b?.openUntil != null && b.state !== 'closed' && { reopensAt: b.openUntil }),
    };
  });

  return {
    tool: input.tool,
    generatedAt: now.toISOString(),
    since: input.since,
    stages,
    models,
    modelChain,
  };
}
