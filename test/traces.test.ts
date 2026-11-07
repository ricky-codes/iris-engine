import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/engine/engine.js';
import { Traces } from '../src/traces/traces.js';

const timings = { gate: 1, rate: 0, access: 30, memories: 2, prompt: 1, models: 900, validate: 1 };
const base = {
  tool: 'reply',
  orgId: '00DAAAAAAAAAAAAAAA',
  userId: '005AAAAAAAAAAAAAAA',
  requestId: 'r1',
  durationMs: 950,
  timings,
};

const ok: EngineEvent = {
  type: 'run_completed',
  ...base,
  model: 'g/primario',
  fallback: true,
  attempts: 2,
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  orgMemories: 1,
  userMemories: 0,
  calls: [
    {
      tool: 'reply',
      model: 'g/primario',
      reason: 'timeout',
      fallback: false,
      attempt: 1,
      durationMs: 500,
    },
    {
      tool: 'reply',
      model: 'o/recurso',
      reason: 'ok',
      fallback: true,
      attempt: 1,
      durationMs: 400,
    },
  ],
};

describe('Traces', () => {
  it('guarda só metadados, com id opaco da org, o caminho e as chamadas', () => {
    const t = new Traces({ enabled: true, perTool: 10, orgKey: 'k' });
    t.record(ok);
    const [trace] = t.list('reply', 20);
    expect(trace).toMatchObject({ id: 'r1', outcome: 'success', durationMs: 950 });
    expect(trace?.orgRef).toMatch(/^[0-9a-f]{16}$/);
    expect(trace?.orgRef).toBe(t.orgRef('00DAAAAAAAAAAAAAAA'));
    expect(trace?.path.map((p) => [p.stage, p.model ?? null])).toEqual([
      ['request', null],
      ['gate', null],
      ['rate', null],
      ['access', null],
      ['memories', null],
      ['prompt', null],
      ['models', 'g/primario'],
      ['models', 'o/recurso'],
      ['validate', null],
      ['response', null],
    ]);
    const json = JSON.stringify(trace);
    expect(json).not.toContain('00DAAAAAAAAAAAAAAA');
    expect(json).not.toContain('005AAAAAAAAAAAAAAA');
  });

  it('um pedido parado acaba no passo onde parou, com o código e a razão', () => {
    const t = new Traces({ enabled: true, perTool: 10, orgKey: 'k' });
    t.record({
      type: 'run_failed',
      ...base,
      code: 'service_unavailable',
      stage: 'access',
      reason: 'stepaccess_unavailable',
      costUsd: undefined,
      calls: [],
    });
    const [trace] = t.list('reply', 1);
    expect(trace).toMatchObject({
      outcome: 'failed',
      code: 'service_unavailable',
      reason: 'stepaccess_unavailable',
    });
    expect(trace?.path.at(-1)).toEqual({ stage: 'access', ms: 30, stopped: true });
  });

  it('guarda os últimos N por ferramenta, mais recentes primeiro, e respeita o interruptor', () => {
    let enabled = true;
    const t = new Traces({ enabled: () => enabled, perTool: 2, orgKey: 'k' });
    for (const id of ['a', 'b', 'c']) t.record({ ...ok, requestId: id });
    expect(t.list('reply', 20).map((x) => x.id)).toEqual(['c', 'b']);
    enabled = false;
    t.record({ ...ok, requestId: 'd' });
    expect(t.list('reply', 20).map((x) => x.id)).toEqual(['c', 'b']);
    // Outra chave dá outro id opaco.
    expect(new Traces({ enabled: true, perTool: 1, orgKey: 'outra' }).orgRef(base.orgId)).not.toBe(
      t.orgRef(base.orgId),
    );
  });
});
