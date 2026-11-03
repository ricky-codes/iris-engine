import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/http/rate-limit.js';

describe('RateLimiter', () => {
  it('com limite 0 deixa passar tudo', () => {
    const l = new RateLimiter(0);
    expect(l.enabled).toBe(false);
    for (let i = 0; i < 1000; i++) expect(l.hit('a').allowed).toBe(true);
  });

  it('recusa acima do limite, por chave, e diz quanto esperar', () => {
    let now = 1_000_000;
    const l = new RateLimiter(2, 60_000, () => now);
    expect(l.hit('a').allowed).toBe(true);
    expect(l.hit('a').allowed).toBe(true);
    now += 10_000;
    const third = l.hit('a');
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(l.hit('b').allowed).toBe(true);
  });

  it('a janela seguinte recomeça a contagem', () => {
    let now = 0;
    const l = new RateLimiter(1, 60_000, () => now);
    expect(l.hit('a').allowed).toBe(true);
    expect(l.hit('a').allowed).toBe(false);
    now = 60_000;
    expect(l.hit('a').allowed).toBe(true);
  });
});
