import type { AccessChecker, AccessRequest } from '../engine/access.js';
import { EngineError } from '../engine/errors.js';
import type { FetchLike } from './fetch.js';

/** Onde e como falar com o StepAccess. */
export interface StepAccessConnection {
  url: string;
  user: string;
  password: string;
  componentUuid: string;
  timeoutMs: number;
}

interface StepAccessResponse {
  hasAccess?: unknown;
  reason?: unknown;
}

const unavailable = (): EngineError =>
  new EngineError('service_unavailable', 'O serviço de licenças não está disponível.');

/**
 * Cliente do `GET /v1/access` do StepAccess. Cada chamada bem-sucedida conta utilização,
 * por isso só se chama depois de o pedido estar validado. Falha fechada: qualquer
 * resposta inesperada recusa o pedido.
 */
export class StepAccessClient implements AccessChecker {
  constructor(
    private readonly config: StepAccessConnection,
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
      throw new EngineError('quota_exceeded', 'Atingiu o limite de utilização do seu plano.', [
        { path: 'access', issue: reason },
      ]);
    }
    throw new EngineError('access_denied', 'Sem acesso à IRIS.', [
      { path: 'access', issue: reason },
    ]);
  }
}
