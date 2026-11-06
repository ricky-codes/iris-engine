/**
 * Disjuntor por modelo, só em memória. Depois de várias falhas de fornecedor seguidas
 * (`provider_unavailable`, `timeout`), o modelo é saltado durante um tempo; a primeira
 * chamada depois disso volta a experimentá-lo. Uma resposta (válida ou não) fecha-o.
 */

export interface OpenBreaker {
  model: string;
  /** Quando abriu pela primeira vez nesta série de falhas. */
  openSince: string;
  /** Até quando o modelo é saltado. */
  openUntil: string;
}

interface State {
  failures: number;
  openUntil: number;
  openSince: number | undefined;
}

export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 60_000;

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
    if (model === undefined) this.states.clear();
    else this.states.delete(model);
    return closed;
  }

  /** `true` se o modelo deve ser saltado agora. */
  isOpen(model: string): boolean {
    const s = this.states.get(model);
    return s !== undefined && s.openUntil > this.now();
  }

  recordFailure(model: string): void {
    const s = this.states.get(model) ?? { failures: 0, openUntil: 0, openSince: undefined };
    s.failures++;
    // Ao fim do tempo aberto, uma nova falha volta a abrir logo (as falhas não recomeçam).
    if (s.failures >= this.threshold) {
      const now = this.now();
      s.openUntil = now + this.openMs;
      s.openSince ??= now;
    }
    this.states.set(model, s);
  }

  recordSuccess(model: string): void {
    this.states.delete(model);
  }

  /** Os modelos que estão a ser saltados agora. */
  open(): OpenBreaker[] {
    const now = this.now();
    return [...this.states]
      .filter(([, s]) => s.openUntil > now && s.openSince !== undefined)
      .map(([model, s]) => ({
        model,
        openSince: new Date(s.openSince ?? now).toISOString(),
        openUntil: new Date(s.openUntil).toISOString(),
      }))
      .sort((a, b) => a.model.localeCompare(b.model));
  }
}
