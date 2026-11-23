import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AdminRoutesOptions } from '../../src/http/routes/admin.js';
import { Metrics } from '../../src/engine/metrics.js';
import { buildTestApp, testSettings } from '../helpers.js';

const SECRET = 'c'.repeat(40);
const unused = async (): Promise<never> => {
  throw new Error('não usado');
};

function admin(over: Partial<AdminRoutesOptions> = {}): AdminRoutesOptions {
  return {
    secret: SECRET,
    pool: {} as Pool,
    tools: [],
    settings: testSettings(),
    breakers: undefined,
    instanceId: 'teste:1',
    metrics: new Metrics(),
    status: unused,
    topology: unused,
    modules: unused,
    models: { list: unused },
    playground: undefined,
    ...over,
  };
}

const metrics = async (opts: AdminRoutesOptions) => {
  const app = await buildTestApp({ admin: opts });
  const res = await app.inject({
    method: 'GET',
    url: '/v1/admin/metrics',
    headers: { authorization: `Bearer ${SECRET}` },
  });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json<{ costReports: unknown; totals: { costUsd: number } }>();
};

describe('GET /v1/admin/metrics: custo', () => {
  it('sem StepAccess não há envios do custo', async () => {
    const body = await metrics(admin());
    expect(body.costReports).toBeNull();
    expect(body.totals.costUsd).toBe(0);
  });

  it('com StepAccess mostra os envios do custo e o custo somado', async () => {
    const stats = {
      delivered: 3,
      failed: 1,
      pending: 0,
      deliveredUsd: 0.01,
      failedUsd: 0.002,
      lastDeliveredAt: null,
      lastFailedAt: null,
      lastFailure: '503',
    };
    const m = new Metrics();
    m.recordCost('reply', 0.004);
    const body = await metrics(admin({ metrics: m, costReports: () => stats }));
    expect(body.costReports).toEqual(stats);
    expect(body.totals.costUsd).toBe(0.004);
  });
});
