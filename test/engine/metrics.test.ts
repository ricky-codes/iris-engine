import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/engine/metrics.js';

describe('Metrics', () => {
  it('soma por ferramenta, por dia e no total, sem guardar mais nada', () => {
    let now = new Date('2026-10-13T10:00:00Z');
    const m = new Metrics(() => now);
    m.record({
      tool: 'sentiment',
      errorCode: undefined,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 2,
    });
    m.record({
      tool: 'sentiment',
      errorCode: undefined,
      durationMs: 300,
      inputTokens: 20,
      outputTokens: 4,
    });
    m.record({ tool: 'sentiment', errorCode: 'access_denied', durationMs: 5 });
    now = new Date('2026-10-14T09:00:00Z');
    m.record({ tool: 'reply', errorCode: 'quota_exceeded', durationMs: 7 });

    const s = m.snapshot();
    expect(s.since).toBe('2026-10-13T10:00:00.000Z');
    expect(s.totals).toEqual({
      requests: 4,
      succeeded: 2,
      failed: 2,
      errorsByCode: { access_denied: 1, quota_exceeded: 1 },
      avgDurationMs: 200,
      inputTokens: 30,
      outputTokens: 6,
    });
    expect(s.byTool.map((t) => [t.tool, t.requests])).toEqual([
      ['reply', 1],
      ['sentiment', 3],
    ]);
    expect(s.byTool[0]?.avgDurationMs).toBeNull();
    expect(s.byDay.map((d) => [d.day, d.requests])).toEqual([
      ['2026-10-13', 3],
      ['2026-10-14', 1],
    ]);
  });

  it('guarda só os últimos 30 dias', () => {
    let day = 1;
    const m = new Metrics(() => new Date(Date.UTC(2026, 0, day)));
    for (; day <= 40; day++) m.record({ tool: 't', errorCode: undefined, durationMs: 1 });
    const s = m.snapshot();
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay[0]?.day).toBe('2026-01-11');
    expect(s.totals.requests).toBe(40);
  });
});
