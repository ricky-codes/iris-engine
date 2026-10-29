import type { FetchLike } from './fetch.js';

export interface CheckResult {
  status: 'ok' | 'failed' | 'not_configured';
  latencyMs: number | null;
  /** Estado HTTP ou tipo de erro, quando falha. Nunca segredos. */
  detail?: string;
}

const TIMEOUT_MS = 3000;

/** Mede uma verificação, com tempo limite. Uma exceção conta como falha. */
export async function timed(fn: () => Promise<string | undefined>): Promise<CheckResult> {
  const started = performance.now();
  try {
    const failure = await fn();
    const latencyMs = Math.round(performance.now() - started);
    return failure === undefined
      ? { status: 'ok', latencyMs }
      : { status: 'failed', latencyMs, detail: failure };
  } catch (err) {
    return {
      status: 'failed',
      latencyMs: Math.round(performance.now() - started),
      detail: err instanceof Error ? err.name : 'erro',
    };
  }
}

/** O StepAccess responde em `/v1/health` sem autenticação e sem contar utilização. */
export function checkStepAccess(url: string, fetchFn: FetchLike = fetch): Promise<CheckResult> {
  return timed(async () => {
    const res = await fetchFn(`${url}/v1/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? undefined : `HTTP ${String(res.status)}`;
  });
}

export interface OpenRouterCredits {
  /** Créditos gastos com esta chave (USD). */
  usage: number | null;
  /** Limite da chave (USD); `null` = sem limite. */
  limit: number | null;
}

/** Valida a chave do OpenRouter e lê o consumo dela. Não chama nenhum modelo. */
export async function checkOpenRouter(
  config: { apiKey: string; baseUrl: string },
  fetchFn: FetchLike = fetch,
): Promise<CheckResult & { credits?: OpenRouterCredits }> {
  let credits: OpenRouterCredits | undefined;
  const result = await timed(async () => {
    const res = await fetchFn(`${config.baseUrl}/key`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return `HTTP ${String(res.status)}`;
    const body = (await res.json()) as { data?: { usage?: unknown; limit?: unknown } };
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    credits = { usage: num(body.data?.usage), limit: num(body.data?.limit) };
    return undefined;
  });
  return credits === undefined ? result : { ...result, credits };
}
