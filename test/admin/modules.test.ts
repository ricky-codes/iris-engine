import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { describeModules, type ModulesInput } from '../../src/admin/modules.js';
import { buildTopology, type RuntimeFacts } from '../../src/admin/topology.js';
import { Metrics } from '../../src/engine/metrics.js';
import { buildTestApp, testSettings } from '../helpers.js';

const OK = { status: 'ok' as const, latencyMs: 5 };
const runtime: RuntimeFacts = {
  service: {
    name: 'iris-engine',
    version: '0.1.0',
    environment: 'production',
    startedAt: '2026-11-02T00:00:00.000Z',
    uptimeSeconds: 1,
  },
  engine: { ready: true, missing: [], defaultModel: 'google/gemini-2.5-flash', maxAttempts: 2 },
  access: 'live',
  openRouter: 'configured',
  routes: { tools: true, memories: true },
  checks: { database: OK, stepAccess: OK, openRouter: OK },
};

function input(over: Partial<ModulesInput> = {}): ModulesInput {
  return {
    topology: buildTopology({
      runtime,
      tools: [],
      breakers: [],
      memories: { org: 1, user: 2, limits: { chars: 500, perOrg: 50, perUser: 20 } },
    }),
    settings: testSettings({ fallbackModels: ['openai/gpt-4.1-mini'] }).describe(),
    access: 'live',
    stepAccess: {
      origin: 'https://access.exemplo.pt',
      componentUuid: '11111111-2222-4333-8444-555555555555',
    },
    openRouter: { baseUrl: 'https://openrouter.ai/api/v1', configured: true },
    memories: { org: 1, user: 2 },
    ...over,
  };
}

describe('describeModules', () => {
  it('descreve os cinco adaptadores, cada um ligado a um nó da topologia', () => {
    const report = describeModules(input());
    expect(report.modules.map((m) => m.className)).toEqual([
      'PgEngineStore',
      'PgMemoryStore',
      'StepAccessClient',
      'StepAccessUsageReporter',
      'OpenRouterProvider',
    ]);
    const ids = new Set(report.modules.map((m) => m.id));
    for (const n of [
      'adapter.pgEngineStore',
      'adapter.pgMemoryStore',
      'adapter.access',
      'adapter.usage',
      'adapter.llm',
    ])
      expect(ids.has(n)).toBe(true);
    for (const m of report.modules) {
      expect(m.settings.length).toBeGreaterThan(0);
      expect(m.proposed.length).toBeGreaterThan(0);
      expect(m.onFailure).not.toBe('');
    }
  });

  it('diz onde se muda cada definição: as das ferramentas e as alteráveis pela API; as ligações só no .env', () => {
    const byClass = new Map(describeModules(input()).modules.map((m) => [m.className, m]));
    const store = byClass.get('PgEngineStore');
    expect(store?.settings.every((s) => s.source === 'database' && s.adminPath !== null)).toBe(
      true,
    );
    const access = byClass.get('StepAccessClient');
    expect(access?.settings.map((s) => [s.key, s.source, s.adminPath])).toEqual([
      ['accessMode', 'env', null],
      ['url', 'env', null],
      ['componentUuid', 'env', null],
      ['timeoutMs', 'env', 'PATCH /v1/admin/settings'],
    ]);
    const llm = byClass.get('OpenRouterProvider');
    expect(
      llm?.settings.filter((s) => s.adminPath === 'PATCH /v1/admin/settings').map((s) => s.key),
    ).toEqual([
      'defaultModel',
      'fallbackModels',
      'totalTimeoutMs',
      'maxAttempts',
      'breakerThreshold',
      'breakerOpenMs',
    ]);
    const memories = byClass.get('PgMemoryStore');
    expect(memories?.settings.find((s) => s.key === 'limits.perOrg')).toMatchObject({
      value: 50,
      source: 'code',
      adminPath: 'PATCH /v1/admin/settings',
    });
  });

  it('mostra os valores em vigor e nunca segredos', () => {
    const json = JSON.stringify(describeModules(input()));
    expect(json).toContain('https://access.exemplo.pt');
    expect(json).toContain('openai/gpt-4.1-mini');
    expect(json).not.toMatch(/password|apiKey":"|sk-or/i);
  });

  it('sem StepAccess (modo aberto) os dois módulos do StepAccess ficam inativos', () => {
    const modules = describeModules(
      input({
        access: 'open',
        stepAccess: { origin: null, componentUuid: null },
      }),
    ).modules;
    const active = Object.fromEntries(modules.map((m) => [m.className, m.active]));
    expect(active).toMatchObject({
      StepAccessClient: false,
      StepAccessUsageReporter: false,
      OpenRouterProvider: true,
    });
  });
});

describe('GET /v1/admin/modules', () => {
  const SECRET = 'a'.repeat(40);
  const build = () =>
    buildTestApp({
      admin: {
        secret: SECRET,
        // Esta rota não toca na base de dados.
        pool: {} as Pool,
        tools: [],
        settings: testSettings(),
        breakers: undefined,
        metrics: new Metrics(),
        status: async () => ({}),
        topology: async () => input().topology,
        modules: async () => describeModules(input()),
        models: { list: async () => ({ fetchedAt: '', models: [] }) },
        playground: undefined,
      },
    });

  it('exige a credencial de administração', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/v1/admin/modules' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/modules',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ modules: unknown[] }>().modules).toHaveLength(5);
    await app.close();
  });
});
