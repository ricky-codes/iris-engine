/**
 * Disjuntor por modelo, só em memória. Depois de várias falhas de fornecedor seguidas
 * (`provider_unavailable`, `timeout`), o modelo é saltado durante um tempo; a primeira
 * chamada depois disso volta a experimentá-lo (meio aberto). Uma resposta (válida ou não) fecha-o.
 */

export interface OpenBreaker {
  model: string;
  /** Quando abriu pela primeira vez nesta série de falhas. */
  openSince: string;
  /** Até quando o modelo é saltado. */
  openUntil: string;
}

/** `closed`: o modelo é usado · `open`: é saltado · `half_open`: a próxima chamada é um teste. */
export type BreakerState = 'closed' | 'open' | 'half_open';

export type BreakerFailure = 'provider_unavailable' | 'timeout';

/** O estado do disjuntor de um modelo usado desde o arranque. */
export interface BreakerStatus {
  model: string;
  state: BreakerState;
  consecutiveFailures: number;
  /** Quando abriu nesta série de falhas; `null` se não abriu. */
  openedAt: string | null;
  /** Até quando é saltado; `null` se não está aberto nem meio aberto. */
  openUntil: string | null;
  /** A última falha do fornecedor neste modelo, desde o arranque. */
  lastError: { reason: BreakerFailure; at: string } | null;
  /** O mesmo que `consecutiveFailures` (nome usado pelo dashboard). */
  failures: number;
  /** Falhas seguidas que abrem o disjuntor (definição `breakerThreshold`). */
  threshold: number;
  /** Quando volta a ser experimentado; `null` se não está aberto. */
  reopensAt: string | null;
}

interface State {
  failures: number;
  openUntil: number;
  openSince: number | undefined;
  lastError: { reason: BreakerFailure; at: number } | undefined;
}

export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

export class CircuitBreaker {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private threshold = BREAKER_THRESHOLD,
    private openMs = BREAKER_OPEN_MS,
  ) {}

  /** Novos valores: valem a partir da próxima falha (os disjuntores abertos ficam como estão). */
  configure(threshold: number, openMs: number): void {
    this.threshold = threshold;
    this.openMs = openMs;
  }

  /** Fecha o disjuntor de um modelo, ou de todos. Devolve os modelos que estavam a ser saltados. */
  reset(model?: string): string[] {
    const closed = this.open()
      .map((b) => b.model)
      .filter((m) => model === undefined || m === model);
    for (const [m, s] of this.states) {
      if (model !== undefined && m !== model) continue;
      s.failures = 0;
      s.openUntil = 0;
      s.openSince = undefined;
    }
    return closed;
  }

  private state(model: string): State {
    let s = this.states.get(model);
    if (s === undefined) {
      s = { failures: 0, openUntil: 0, openSince: undefined, lastError: undefined };
      this.states.set(model, s);
    }
    return s;
  }

  /** `true` se o modelo deve ser saltado agora. */
  isOpen(model: string): boolean {
    const s = this.states.get(model);
    return s !== undefined && s.openUntil > this.now();
  }

  recordFailure(model: string, reason: BreakerFailure = 'provider_unavailable'): void {
    const s = this.state(model);
    const now = this.now();
    s.failures++;
    s.lastError = { reason, at: now };
    // Ao fim do tempo aberto, uma nova falha volta a abrir logo (as falhas não recomeçam).
    if (s.failures >= this.threshold) {
      s.openUntil = now + this.openMs;
      s.openSince ??= now;
    }
  }

  recordSuccess(model: string): void {
    const s = this.state(model);
    s.failures = 0;
    s.openUntil = 0;
    s.openSince = undefined;
  }

  /** Os modelos que estão a ser saltados agora. */
  open(): OpenBreaker[] {
    const now = this.now();
    return [...this.states]
      .filter(([, s]) => s.openUntil > now && s.openSince !== undefined)
      .map(([model, s]) => ({
        model,
        openSince: iso(s.openSince ?? now),
        openUntil: iso(s.openUntil),
      }))
      .sort((a, b) => a.model.localeCompare(b.model));
  }

  /** O estado de cada modelo chamado desde o arranque, por ordem de nome. */
  status(): BreakerStatus[] {
    const now = this.now();
    return [...this.states]
      .map(([model, s]): BreakerStatus => {
        const tripped = s.openSince !== undefined;
        const state: BreakerState = !tripped ? 'closed' : s.openUntil > now ? 'open' : 'half_open';
        return {
          model,
          state,
          consecutiveFailures: s.failures,
          openedAt: s.openSince === undefined ? null : iso(s.openSince),
          openUntil: tripped ? iso(s.openUntil) : null,
          failures: s.failures,
          threshold: this.threshold,
          reopensAt: state === 'open' ? iso(s.openUntil) : null,
          lastError:
            s.lastError === undefined
              ? null
              : { reason: s.lastError.reason, at: iso(s.lastError.at) },
        };
      })
      .sort((a, b) => a.model.localeCompare(b.model));
  }
}
