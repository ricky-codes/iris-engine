import { describe, expect, it } from 'vitest';
import { buildPipeline, type PipelineInput } from '../../src/admin/pipeline.js';
import { buildTopology, type RuntimeFacts } from '../../src/admin/topology.js';
import { Metrics } from '../../src/engine/metrics.js';
import { resolveOverrides } from '../../src/engine/store.js';

const OK = { status: 'ok' as const, latencyMs: 5 };
const runtime: RuntimeFacts = {
  service: {
    name: 'iris-engine',
    version: '0.1.0',
    environment: 'test',
    startedAt: '',
    uptimeSeconds: 1,
  },
  engine: { ready: true, missing: [], defaultModel: 'g/primario', maxAttempts: 2 },
  access: 'live',
  openRouter: 'configured',
  routes: { tools: true, memories: true },
  checks: { database: OK, stepAccess: OK, openRouter: OK },
};
const engine = {
  maxAttempts: 2,
  totalTimeoutMs: 30_000,
  rateLimitPerMinute: 0,
  streamEnabled: true,
};

function input(metrics: Metrics, over: Partial<PipelineInput> = {}): PipelineInput {
  return {
    tool: 'reply',
    implemented: true,
    enabled: true,
    streamSupported: true,
    model: 'g/primario',
    fallbackModels: ['o/recurso'],
    prompt: { source: 'database', activeVersion: 3 },
    overrides: resolveOverrides({ rateLimitPerMinute: 10 }, engine),
    since: metrics.since,
    metrics: metrics.pipeline('reply'),
    breakers: [],
    topology: buildTopology({
      runtime,
      tools: [],
      breakers: [],
      memories: { org: 0, user: 0, limits: { chars: 500, perOrg: 50, perUser: 20 } },
    }),
    ...over,
  };
}

describe('buildPipeline', () => {
  it('conta, em cada passo, os que passaram e os que pararam, pela ordem do pedido', () => {
    const m = new Metrics();
    const fail = (stage: 'request' | 'rate' | 'access' | 'validate', code: string) => {
      m.record({ tool: 'reply', errorCode: code, stage, durationMs: 1 });
    };
    for (let i = 0; i < 6; i++) m.record({ tool: 'reply', errorCode: undefined, durationMs: 100 });
    fail('request', 'invalid_request');
    fail('rate', 'rate_limited');
    fail('rate', 'rate_limited');
    fail('access', 'access_denied');
    fail('validate', 'invalid_model_output');
    const p = buildPipeline(input(m));
    const counts = Object.fromEntries(p.stages.map((s) => [s.id, s.counts]));
    expect(counts).toEqual({
      auth: { passed: 11, stopped: 0 },
      request: { passed: 10, stopped: 1 },
      gate: { passed: 10, stopped: 0 },
      rate: { passed: 8, stopped: 2 },
      access: { passed: 7, stopped: 1 },
      memories: { passed: 7, stopped: 0 },
      prompt: { passed: 7, stopped: 0 },
      models: { passed: 7, stopped: 0 },
      validate: { passed: 6, stopped: 1 },
      response: { passed: 6, stopped: 0 },
    });
    const rate = p.stages.find((s) => s.id === 'rate');
    expect(rate).toMatchObject({
      status: 'warning',
      stoppedByCode: { rate_limited: 2 },
      details: { limitPerMinute: 10, source: 'tool' },
      summary: '10 pedidos por minuto por org nesta ferramenta',
    });
    expect(p.stages.find((s) => s.id === 'prompt')?.summary).toBe('Base de dados, versão 3');
  });

  it('desligada, disjuntor aberto e respostas inválidas aparecem no passo certo', () => {
    const m = new Metrics();
    for (let i = 0; i < 5; i++) {
      m.recordModelCall({
        tool: 'reply',
        model: 'g/primario',
        reason: i < 2 ? 'invalid_output' : 'ok',
        fallback: false,
        attempt: i === 1 ? 2 : 1,
        durationMs: 10,
      });
    }
    const p = buildPipeline(
      input(m, {
        enabled: false,
        breakers: [
          {
            model: 'o/recurso',
            state: 'open',
            consecutiveFailures: 3,
            openedAt: '2026-11-06T10:00:00.000Z',
            openUntil: '2026-11-06T10:01:00.000Z',
            lastError: { reason: 'timeout', at: '2026-11-06T10:00:00.000Z' },
            failures: 3,
            threshold: 3,
            reopensAt: '2026-11-06T10:01:00.000Z',
          },
        ],
      }),
    );
    const stage = (id: string) => p.stages.find((s) => s.id === id);
    expect(stage('gate')).toMatchObject({ status: 'off', details: { enabled: false } });
    expect(stage('models')).toMatchObject({
      status: 'warning',
      summary: 'Disjuntor aberto: recurso',
      details: { openBreakers: 1, fallbacks: 1 },
    });
    expect(stage('validate')).toMatchObject({
      status: 'warning',
      details: { invalidOutputs: 2, retries: 1 },
    });
    expect(p.models).toEqual([
      {
        model: 'g/primario',
        role: 'primary',
        breaker: { state: 'closed', openUntil: null, consecutiveFailures: 0 },
        calls: 5,
        succeeded: 3,
        avgDurationMs: 10,
        failedByReason: {
          provider_unavailable: 0,
          timeout: 0,
          invalid_output: 2,
          skipped_breaker: 0,
        },
        servedAsFallback: 0,
      },
      expect.objectContaining({
        model: 'o/recurso',
        role: 'fallback',
        breaker: { state: 'open', openUntil: '2026-11-06T10:01:00.000Z', consecutiveFailures: 3 },
        calls: 0,
      }),
    ]);
  });
});
