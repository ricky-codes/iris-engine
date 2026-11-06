/**
 * Limite de pedidos por chave, em janelas fixas de um minuto, em memória. Cada instância conta
 * por si; serve para travar um cliente descontrolado, não para faturação. O limite vem em cada
 * pedido, porque depende da ferramenta (ver `rateLimitPerMinute` nas definições).
 */
export class RateLimiter {
  private readonly counts = new Map<string, number>();
  private windowStart = 0;

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Conta um pedido com o limite dado (0 = sem limite, e não conta). `retryAfterSeconds` só vem
   * quando o pedido foi recusado.
   */
  hit(
    key: string,
    limit: number,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
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
