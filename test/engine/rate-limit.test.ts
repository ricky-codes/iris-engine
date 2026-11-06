import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/engine/rate-limit.js';

describe('RateLimiter', () => {
  it('com limite 0 deixa passar tudo e não conta', () => {
    const l = new RateLimiter();
    for (let i = 0; i < 1000; i++) expect(l.hit('a', 0).allowed).toBe(true);
    expect(l.hit('a', 1).allowed).toBe(true);
  });

  it('recusa acima do limite, por chave, e diz quanto esperar', () => {
    let now = 1_000_000;
    const l = new RateLimiter(60_000, () => now);
    expect(l.hit('a', 2).allowed).toBe(true);
    expect(l.hit('a', 2).allowed).toBe(true);
    now += 10_000;
    expect(l.hit('a', 2)).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(l.hit('b', 2).allowed).toBe(true);
  });

  it('o limite é o de cada pedido: subir o limite deixa passar logo', () => {
    const l = new RateLimiter(60_000, () => 0);
    expect(l.hit('a', 1).allowed).toBe(true);
    expect(l.hit('a', 1).allowed).toBe(false);
    expect(l.hit('a', 3).allowed).toBe(true);
  });

  it('a janela seguinte recomeça a contagem', () => {
    let now = 0;
    const l = new RateLimiter(60_000, () => now);
    expect(l.hit('a', 1).allowed).toBe(true);
    expect(l.hit('a', 1).allowed).toBe(false);
    now = 60_000;
    expect(l.hit('a', 1).allowed).toBe(true);
  });
});
