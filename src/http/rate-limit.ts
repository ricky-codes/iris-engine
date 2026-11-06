import { read, type Live } from '../engine/live.js';

/**
 * Limite de pedidos por chave (a org), em janelas fixas de um minuto, em memória. Cada instância
 * conta por si; serve para travar um cliente descontrolado, não para faturação.
 */
export class RateLimiter {
  private readonly counts = new Map<string, number>();
  private windowStart = 0;

  constructor(
    /** Pedidos por janela; 0 desliga o limite. Lido em cada pedido. */
    private readonly limit: Live<number>,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return read(this.limit) > 0;
  }

  /** Conta um pedido. `retryAfterSeconds` só vem quando o pedido foi recusado. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const limit = read(this.limit);
    if (limit <= 0) return { allowed: true };
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      // Janela nova: as contagens antigas deixam de interessar (e a memória não cresce).
      this.counts.clear();
      this.windowStart = now;
    }
    const used = (this.counts.get(key) ?? 0) + 1;
    if (used > limit) {
      const left = Math.ceil((this.windowStart + this.windowMs - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, left) };
    }
    this.counts.set(key, used);
    return { allowed: true };
  }
}
