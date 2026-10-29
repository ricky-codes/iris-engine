import { describe, expect, it } from 'vitest';
import { StepAccessUsageReporter } from '../../src/adapters/stepaccess-usage.js';
import type { CostEvent } from '../../src/engine/usage.js';
import { fakeFetch, json } from '../engine/fakes.js';

const CONFIG = {
  url: 'https://access.example.com',
  user: 'iris',
  password: 'segredo',
  componentUuid: '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
  timeoutMs: 1000,
};
const EVENT: CostEvent = {
  requestId: '6f1c2a3b-0000-4000-8000-000000000001',
  orgId: '00DAAAAAAAAAAAAAAA',
  userId: '005AAAAAAAAAAAAAAA',
  tool: 'sentiment',
  outcome: 'success',
  model: 'google/gemini-2.5-flash',
  attempts: 1,
  inputTokens: 1200,
  outputTokens: 150,
  costUsd: 0.00042,
  occurredAt: '2026-10-25T10:00:00.000Z',
};

function reporter(respond: () => Response) {
  const f = fakeFetch(respond);
  const logs: { msg: string; data: Record<string, unknown> }[] = [];
  const r = new StepAccessUsageReporter(CONFIG, f.fn, (msg, data) => logs.push({ msg, data }), 0);
  return { r, f, logs };
}

describe('StepAccessUsageReporter', () => {
  it('envia o custo com o componente e autenticação Basic', async () => {
    const { r, f } = reporter(() => json(201, {}));
    expect(await r.send(EVENT)).toBe(true);
    expect(f.calls[0]?.url).toBe('https://access.example.com/v1/usage/cost');
    expect(f.calls[0]?.init?.method).toBe('POST');
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('iris:segredo').toString('base64')}`,
    );
    expect(JSON.parse(f.calls[0]?.init?.body as string)).toEqual({
      componentUuid: CONFIG.componentUuid,
      ...EVENT,
    });
  });

  it('campos em falta seguem como null', async () => {
    const { r, f } = reporter(() => json(201, {}));
    await r.send({ ...EVENT, costUsd: undefined, inputTokens: undefined });
    expect(JSON.parse(f.calls[0]?.init?.body as string)).toMatchObject({
      costUsd: null,
      inputTokens: null,
    });
  });

  it('409 (repetido) conta como entregue', async () => {
    const { r, f } = reporter(() => json(409, {}));
    expect(await r.send(EVENT)).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it('5xx tenta outra vez; se falhar, escreve o evento no log', async () => {
    const { r, f, logs } = reporter(() => json(503, {}));
    expect(await r.send(EVENT)).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(logs).toEqual([
      { msg: 'stepaccess cost not reported', data: { status: 503, event: EVENT } },
    ]);
  });

  it('4xx não tenta outra vez', async () => {
    const { r, f, logs } = reporter(() => json(422, {}));
    expect(await r.send(EVENT)).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it('rede em baixo: tenta outra vez e regista', async () => {
    const { r, f, logs } = reporter(() => {
      throw new TypeError('fetch failed');
    });
    expect(await r.send(EVENT)).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(logs[0]?.data['status']).toBe('TypeError');
  });
});
