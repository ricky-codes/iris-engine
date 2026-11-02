import type { BreakerFact, Topology } from '../admin/topology.js';
import type { Alert, AlertSeverity } from './types.js';
import type { ToolWindow } from './window.js';

/** Uma condição que está mal agora. O monitor transforma-a em alerta (e decide quando enviar). */
export interface Condition {
  key: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  nodeId: string | null;
  details: Alert['details'];
}

export interface RuleInput {
  topology: Topology;
  /** O que aconteceu a cada ferramenta na janela. */
  window: ToolWindow[];
  windowMs: number;
  breakers: BreakerFact[];
  now: number;
}

/**
 * Erros do lado da IRIS ou do fornecedor. Recusas de licença (`access_denied`, `quota_exceeded`)
 * e pedidos mal feitos (`invalid_request`) não contam: não são falhas do motor.
 */
export const SERVER_ERROR_CODES = new Set([
  'provider_unavailable',
  'timeout',
  'invalid_model_output',
  'service_unavailable',
  'internal_error',
]);

export const THRESHOLDS = {
  minRequests: 5,
  failureWarning: 0.2,
  failureError: 0.5,
  fallbackWarning: 0.2,
  creditsWarning: 0.9,
  creditsError: 1,
  breakerOpenMs: 5 * 60_000,
};

/**
 * Os módulos que dão alerta quando ficam em erro: os serviços externos e o motor (configuração
 * em falta). Os que só herdam o erro de outro (interfaces, adaptadores, memórias) não repetem
 * o mesmo problema. O próprio webhook dos alertas tem o seu estado na API, não em alerta.
 */
const alertsOnError = (id: string, layer: string): boolean =>
  (layer === 'external' && id !== 'external.webhook') || id === 'core.engine';

const pct = (part: number, whole: number): number => Math.round((part / whole) * 100);
const minutes = (ms: number): string => `${String(Math.max(1, Math.round(ms / 60_000)))} min`;

export function evaluateRules(input: RuleInput): Condition[] {
  const { topology, window, windowMs, breakers, now } = input;
  const out: Condition[] = [];

  // Módulos em erro: Postgres, StepAccess ou OpenRouter em baixo, configuração em falta.
  for (const n of topology.nodes) {
    if (n.status !== 'error' || !alertsOnError(n.id, n.layer)) continue;
    out.push({
      key: `${n.id}.error`,
      severity: 'error',
      title: `${n.label} não funciona`,
      summary: n.summary,
      nodeId: n.id,
      details: { status: n.status },
    });
  }

  // Créditos do OpenRouter.
  const or = topology.nodes.find((n) => n.id === 'external.openrouter');
  const used = or?.details.creditsUsedUsd;
  const limit = or?.details.creditsLimitUsd;
  if (typeof used === 'number' && typeof limit === 'number' && limit > 0) {
    const ratio = used / limit;
    if (ratio >= THRESHOLDS.creditsWarning) {
      out.push({
        key: 'openrouter.credits',
        severity: ratio >= THRESHOLDS.creditsError ? 'error' : 'warning',
        title: `Créditos do OpenRouter a ${String(pct(used, limit))}% do limite`,
        summary: `Gastos ${used.toFixed(2)} de ${limit.toFixed(2)} USD. Sem créditos, os pedidos falham.`,
        nodeId: 'external.openrouter',
        details: { usedUsd: used, limitUsd: limit },
      });
    }
  }

  // Ferramentas com muitas falhas na janela.
  for (const t of window) {
    const errors: Record<string, number> = {};
    let failed = 0;
    for (const [code, n] of Object.entries(t.errorsByCode)) {
      if (!SERVER_ERROR_CODES.has(code)) continue;
      errors[code] = n;
      failed += n;
    }
    if (t.requests < THRESHOLDS.minRequests || failed / t.requests < THRESHOLDS.failureWarning)
      continue;
    const codes = Object.entries(errors)
      .sort(([, a], [, b]) => b - a)
      .map(([code, n]) => `${code}: ${String(n)}`)
      .join(', ');
    out.push({
      key: `tool.${t.tool}.failure_rate`,
      severity: failed / t.requests >= THRESHOLDS.failureError ? 'error' : 'warning',
      title: `Ferramenta ${t.tool} com ${String(pct(failed, t.requests))}% de falhas`,
      summary: `${String(failed)} de ${String(t.requests)} pedidos falharam nos últimos ${minutes(windowMs)} (${codes}).`,
      nodeId: `tool.${t.tool}`,
      details: { requests: t.requests, failed, errorsByCode: errors },
    });
  }

  // Muitos pedidos servidos por modelos de recurso.
  const requests = window.reduce((n, t) => n + t.requests, 0);
  const fallbacks = window.reduce((n, t) => n + t.fallbacks, 0);
  if (requests >= THRESHOLDS.minRequests && fallbacks / requests >= THRESHOLDS.fallbackWarning) {
    out.push({
      key: 'llm.fallback_rate',
      severity: 'warning',
      title: `${String(pct(fallbacks, requests))}% dos pedidos servidos por modelos de recurso`,
      summary: `${String(fallbacks)} de ${String(requests)} pedidos nos últimos ${minutes(windowMs)} só tiveram resposta com um modelo de recurso. O modelo principal está a falhar.`,
      nodeId: 'adapter.llm',
      details: { requests, fallbacks },
    });
  }

  // Disjuntores abertos há demasiado tempo.
  for (const b of breakers) {
    const openMs = now - Date.parse(b.openSince);
    if (openMs < THRESHOLDS.breakerOpenMs) continue;
    out.push({
      key: `llm.breaker.${b.model}`,
      severity: 'warning',
      title: `Modelo ${b.model} a ser saltado há ${minutes(openMs)}`,
      summary: `O disjuntor está aberto: o modelo falhou várias vezes seguidas e os pedidos passam para os modelos de recurso.`,
      nodeId: 'adapter.llm',
      details: { model: b.model, openSince: b.openSince },
    });
  }

  return out;
}
