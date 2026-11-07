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
      fallback: true,
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
      fallbacks: 1,
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

  it('conta pedidos servidos por modelos de recurso só quando correram bem', () => {
    const m = new Metrics();
    m.record({ tool: 'reply', errorCode: undefined, durationMs: 1, fallback: true });
    m.record({ tool: 'reply', errorCode: 'timeout', durationMs: 1, fallback: true });
    m.record({ tool: 'reply', errorCode: undefined, durationMs: 1, fallback: false });
    expect(m.snapshot().byTool[0]).toMatchObject({ requests: 3, fallbacks: 1 });
  });

  it('conta as chamadas a cada modelo, por motivo e por ferramenta, sem contar os saltos como chamadas', () => {
    const m = new Metrics();
    const call = (over: Partial<Parameters<Metrics['recordModelCall']>[0]>) => {
      m.recordModelCall({
        tool: 'reply',
        model: 'b/modelo',
        reason: 'ok',
        fallback: false,
        attempt: 1,
        durationMs: 100,
        ...over,
      });
    };
    call({});
    call({ durationMs: 300, fallback: true });
    call({ reason: 'timeout', durationMs: 9000 });
    call({ reason: 'invalid_output', attempt: 1 });
    call({ reason: 'skipped_breaker', durationMs: 0 });
    call({ tool: 'sentiment', model: 'a/outro', reason: 'provider_unavailable', durationMs: 50 });
    const none = { provider_unavailable: 0, timeout: 0, invalid_output: 0, skipped_breaker: 0 };
    const s = m.snapshot();
    expect(s.byModel).toEqual([
      {
        model: 'a/outro',
        calls: 1,
        failed: 1,
        failedByReason: { ...none, provider_unavailable: 1 },
        avgDurationMs: null,
      },
      {
        model: 'b/modelo',
        calls: 4,
        failed: 2,
        failedByReason: { ...none, timeout: 1, invalid_output: 1, skipped_breaker: 1 },
        avgDurationMs: 200,
      },
    ]);
    m.record({ tool: 'reply', errorCode: undefined, durationMs: 1 });
    expect(m.snapshot().byTool[0]).toMatchObject({
      tool: 'reply',
      byModel: [{ model: 'b/modelo', calls: 4, servedAsFallback: 1 }],
    });
    // Nas métricas do diagrama, também as novas tentativas no mesmo modelo.
    call({ attempt: 2 });
    expect(m.pipeline('reply').byModel[0]).toMatchObject({ calls: 5, retries: 1 });
  });

  it('regista o passo em que cada pedido parou, e as memórias e o acesso dos que correram', () => {
    const m = new Metrics();
    m.record({ tool: 'reply', errorCode: 'tool_disabled', stage: 'gate', durationMs: 1 });
    m.record({ tool: 'reply', errorCode: 'rate_limited', stage: 'rate', durationMs: 1 });
    m.record({ tool: 'reply', errorCode: 'rate_limited', stage: 'rate', durationMs: 1 });
    m.record({ tool: 'reply', errorCode: 'internal_error', durationMs: 1 });
    m.recordRun({
      tool: 'reply',
      timings: { gate: 0, rate: 0, access: 42, memories: 1, prompt: 1, models: 10, validate: 1 },
      orgMemories: 2,
      userMemories: 1,
      checkedAccess: true,
    });
    m.recordRun({
      tool: 'reply',
      timings: { gate: 0, rate: 0, access: 7, memories: 1, prompt: 1, models: 10, validate: 1 },
      orgMemories: 1,
      userMemories: 0,
      checkedAccess: true,
    });
    const p = m.pipeline('reply');
    expect(p.stops).toMatchObject({
      gate: { tool_disabled: 1 },
      rate: { rate_limited: 2 },
      access: {},
      // Sem passo marcado, conta na resposta.
      response: { internal_error: 1 },
    });
    expect(p.memories).toEqual({ runs: 2, orgAvg: 1.5, userAvg: 0.5 });
    expect(p.lastAccessMs).toBe(7);
    expect(m.snapshot().byTool[0]?.errorsByCode).toEqual({
      internal_error: 1,
      rate_limited: 2,
      tool_disabled: 1,
    });
    expect(m.pipeline('outra')).toMatchObject({
      counters: { requests: 0 },
      byModel: [],
      lastAccessMs: null,
    });
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

  it('fluxo por ferramenta: passos com tempos, percentis, últimos 60 minutos, modelos e pares de recurso', () => {
    let now = Date.UTC(2026, 10, 7, 10, 0);
    const m = new Metrics(() => new Date(now));
    const timings = {
      gate: 2,
      rate: 0,
      access: 40,
      memories: 4,
      prompt: 1,
      models: 900,
      validate: 1,
    };
    m.record({ tool: 'reply', errorCode: undefined, durationMs: 1000 });
    m.recordRun({ tool: 'reply', timings, checkedAccess: true, models: ['g/a', 'o/b'] });
    m.recordModelCall({
      tool: 'reply',
      model: 'o/b',
      reason: 'ok',
      fallback: true,
      attempt: 1,
      durationMs: 300,
    });
    now += 2 * 60_000;
    m.record({
      tool: 'reply',
      errorCode: 'service_unavailable',
      stage: 'access',
      reason: 'stepaccess_unavailable',
      durationMs: 50,
    });
    m.recordRun({
      tool: 'reply',
      timings: { ...timings, access: 20 },
      checkedAccess: true,
      stoppedAt: 'access',
    });
    const f = m.snapshot().byTool[0];
    expect(f?.stages.access).toEqual({
      entered: 2,
      passed: 1,
      stopped: 1,
      byCode: { stepaccess_unavailable: 1 },
      avgMs: 30,
    });
    expect(f?.stages.models).toMatchObject({ entered: 1, avgMs: 900 });
    expect(f?.stages.request.avgMs).toBeNull();
    expect(f?.fallbackPairs).toEqual([{ from: 'g/a', to: 'o/b', count: 1 }]);
    expect(f?.models).toEqual([
      expect.objectContaining({ model: 'o/b', calls: 1, p95Ms: 300, fallbackFrom: 1 }),
    ]);
    expect([f?.p50Ms, f?.p95Ms]).toEqual([50, 1000]);
    expect(f?.recent).toEqual([
      { minute: '2026-11-07T10:00:00.000Z', requests: 1, failed: 0 },
      { minute: '2026-11-07T10:02:00.000Z', requests: 1, failed: 1 },
    ]);
    now += 90 * 60_000;
    expect(m.snapshot().byTool[0]?.recent).toEqual([]);
  });
});
