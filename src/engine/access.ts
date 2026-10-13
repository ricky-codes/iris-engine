import { AppError } from '../http/errors.js';
import type { StepAccessConfig } from '../config.js';

export interface AccessRequest {
  orgId: string;
  userId: string;
}

/** Pergunta se o utilizador pode usar a IRIS agora. Lança `AppError` se não puder. */
export interface AccessChecker {
  check(request: AccessRequest): Promise<void>;
}

export type FetchLike = typeof fetch;

interface StepAccessResponse {
  hasAccess?: unknown;
  reason?: unknown;
}

const unavailable = (): AppError =>
  new AppError('service_unavailable', 503, 'O serviço de licenças não está disponível.');

/**
 * Cliente do `GET /v1/access` do StepAccess. Cada chamada bem-sucedida conta utilização,
 * por isso só se chama depois de o pedido estar validado. Falha fechada: qualquer
 * resposta inesperada recusa o pedido.
 */
export class StepAccessClient implements AccessChecker {
  constructor(
    private readonly config: StepAccessConfig,
    private readonly fetchFn: FetchLike = fetch,
    private readonly log: (msg: string, data: Record<string, unknown>) => void = () => undefined,
  ) {}

  async check({ orgId, userId }: AccessRequest): Promise<void> {
    const url = new URL(`${this.config.url}/v1/access`);
    url.searchParams.set('orgId', orgId);
    url.searchParams.set('userId', userId);
    url.searchParams.set('componentUuid', this.config.componentUuid);
    const basic = Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64');

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      this.log('stepaccess unreachable', { err: err instanceof Error ? err.name : String(err) });
      throw unavailable();
    }

    if (res.status !== 200) {
      this.log('stepaccess unexpected status', { status: res.status });
      throw unavailable();
    }

    let body: StepAccessResponse;
    try {
      body = (await res.json()) as StepAccessResponse;
    } catch {
      this.log('stepaccess invalid body', {});
      throw unavailable();
    }

    if (body.hasAccess === true) return;
    if (body.hasAccess !== false) {
      this.log('stepaccess invalid body', {});
      throw unavailable();
    }

    const reason = typeof body.reason === 'string' ? body.reason : 'UNKNOWN';
    if (reason === 'LIMIT_REACHED') {
      throw new AppError('quota_exceeded', 429, 'Atingiu o limite de utilização do seu plano.', [
        { path: 'access', issue: reason },
      ]);
    }
    throw new AppError('access_denied', 403, 'Sem acesso à IRIS.', [
      { path: 'access', issue: reason },
    ]);
  }
}

/** Sem StepAccess: deixa passar tudo. Só para desenvolvimento (proibido em produção). */
export class BypassAccessChecker implements AccessChecker {
  async check(): Promise<void> {
    // Intencionalmente vazio.
  }
}
