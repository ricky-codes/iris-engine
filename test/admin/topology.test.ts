import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  type RuntimeFacts,
  type ToolFact,
  type TopologyInput,
} from '../../src/admin/topology.js';

const OK = { status: 'ok' as const, latencyMs: 12 };

function runtime(over: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return {
    service: {
      name: 'iris-engine',
      version: '0.1.0',
      environment: 'production',
      startedAt: '2026-11-02T00:00:00.000Z',
      uptimeSeconds: 60,
    },
    engine: { ready: true, missing: [], defaultModel: 'google/gemini-2.5-flash', maxAttempts: 2 },
    access: 'live',
    openRouter: 'configured',
    routes: { tools: true, memories: true },
    auth: 'token',
    checks: {
      database: OK,
      stepAccess: OK,
      openRouter: { ...OK, credits: { usage: 1, limit: 100 } },
    },
    ...over,
  };
}

const sentiment: ToolFact = {
  name: 'sentiment',
  implemented: true,
  version: 1,
  enabled: true,
  model: 'google/gemini-2.5-flash',
  modelSource: 'default',
  prompt: { source: 'code', version: null },
  fallbackModels: [],
  requests: 10,
  failed: 0,
  fallbacks: 0,
};
const reply: ToolFact = {
  name: 'reply',
  implemented: false,
  version: null,
  enabled: true,
  model: null,
  modelSource: null,
  prompt: { source: 'none', version: null },
  fallbackModels: [],
  requests: 0,
  failed: 0,
  fallbacks: 0,
};

function topology(over: Partial<TopologyInput> = {}) {
  return buildTopology(
    {
      runtime: runtime(),
      tools: [sentiment, reply],
      breakers: [],
      memories: { org: 3, user: 7, limits: { chars: 500, perOrg: 50, perUser: 20 } },
      orgKeys: {
        activeKeys: 3,
        orgsWithKeys: 2,
        lastUsedAt: '2026-11-02T11:59:00.000Z',
        tokensAccepted: 40,
        tokensRejected: 1,
      },
      ...over,
    },
    new Date('2026-11-02T12:00:00.000Z'),
  );
}

const node = (t: ReturnType<typeof topology>, id: string) => {
  const n = t.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`sem nó ${id}`);
  return n;
};
const hasEdge = (t: ReturnType<typeof topology>, from: string, to: string) =>
  t.edges.some((e) => e.from === from && e.to === to);

describe('buildTopology', () => {
  it('com tudo ligado, está tudo ok e as ligações apontam para nós que existem', () => {
    const t = topology();
    expect(t.overall).toBe('ok');
    expect(t.generatedAt).toBe('2026-11-02T12:00:00.000Z');
    const ids = new Set(t.nodes.map((n) => n.id));
    expect(ids.size).toBe(t.nodes.length);
    for (const e of t.edges) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
    for (const n of t.nodes) expect(t.layers).toContain(n.layer);
    expect(node(t, 'adapter.access')).toMatchObject({ label: 'StepAccessClient', status: 'ok' });
    expect(hasEdge(t, 'adapter.access', 'external.stepaccess')).toBe(true);
    expect(node(t, 'core.memories')).toMatchObject({
      summary: '3 da org · 7 de utilizadores',
      configure: { where: 'admin_api', path: '/v1/admin/memories' },
    });
  });

  it('chaves das orgs: nó, interface, adaptador e ligações a partir das rotas públicas', () => {
    const t = topology();
    expect(node(t, 'core.orgKeys')).toMatchObject({
      status: 'ok',
      summary: '3 chave(s) ativa(s) em 2 org(s)',
      details: { mode: 'token', activeKeys: 3, tokensRejected: 1 },
      configure: { where: 'admin_api', path: '/v1/admin/orgs/:orgId/keys' },
    });
    expect(node(t, 'adapter.pgOrgKeyStore').status).toBe('ok');
    expect(hasEdge(t, 'http.tools', 'core.orgKeys')).toBe(true);
    expect(hasEdge(t, 'http.memories', 'core.orgKeys')).toBe(true);
    expect(hasEdge(t, 'http.admin', 'core.orgKeys')).toBe(true);
    expect(hasEdge(t, 'adapter.pgOrgKeyStore', 'external.postgres')).toBe(true);
    expect(node(t, 'http.tools').details).toMatchObject({ auth: 'token da org (JWT)' });
  });

  it('chaves das orgs: sem chave mestra é erro; sem chaves ou muitas recusas é aviso', () => {
    const missing = topology({ orgKeys: undefined });
    expect(node(missing, 'core.orgKeys')).toMatchObject({
      status: 'error',
      configure: { where: 'env', keys: ['AUTH_MODE', 'ORG_KEY_ENCRYPTION_KEY'] },
    });
    expect(node(missing, 'adapter.pgOrgKeyStore').status).toBe('off');

    const none = {
      activeKeys: 0,
      orgsWithKeys: 0,
      lastUsedAt: null,
      tokensAccepted: 0,
      tokensRejected: 0,
    };
    expect(node(topology({ orgKeys: none }), 'core.orgKeys').status).toBe('warning');
    const rejecting = {
      ...none,
      activeKeys: 1,
      orgsWithKeys: 1,
      tokensAccepted: 4,
      tokensRejected: 4,
    };
    expect(node(topology({ orgKeys: rejecting }), 'core.orgKeys').status).toBe('warning');
  });

  it('segredo partilhado: aviso, e as rotas públicas não passam pelas chaves', () => {
    const t = topology({ runtime: runtime({ auth: 'shared_secret' }) });
    expect(node(t, 'core.orgKeys').status).toBe('warning');
    expect(hasEdge(t, 'http.tools', 'core.orgKeys')).toBe(false);
    expect(node(t, 'http.tools').details).toMatchObject({ auth: 'API_SECRET' });
  });

  it('modo aberto: sem StepAccess, sem envio de custo, e isso não é um erro', () => {
    const t = topology({
      runtime: runtime({
        access: 'open',
        checks: {
          database: OK,
          stepAccess: { status: 'not_configured', latencyMs: null },
          openRouter: OK,
        },
      }),
    });
    expect(t.overall).toBe('ok');
    expect(node(t, 'adapter.access')).toMatchObject({ label: 'OpenAccessChecker', status: 'ok' });
    expect(node(t, 'external.stepaccess').status).toBe('off');
    expect(node(t, 'adapter.usage')).toMatchObject({ status: 'off', label: 'sem envio' });
    expect(hasEdge(t, 'adapter.access', 'external.stepaccess')).toBe(false);
    expect(node(t, 'adapter.access').configure).toMatchObject({ where: 'env' });
  });

  it('bypass é um aviso; sem StepAccess configurado é um erro', () => {
    expect(
      node(topology({ runtime: runtime({ access: 'bypass' }) }), 'adapter.access').status,
    ).toBe('warning');
    const missing = topology({
      runtime: runtime({
        access: 'missing',
        engine: { ready: false, missing: ['STEPACCESS_URL'], defaultModel: 'm', maxAttempts: 2 },
        routes: { tools: false, memories: true },
      }),
    });
    expect(missing.overall).toBe('error');
    expect(node(missing, 'core.engine')).toMatchObject({
      status: 'error',
      summary: 'Desligado: falta STEPACCESS_URL',
      // As definições deste módulo que se mudam pela API.
      configure: {
        where: 'admin_api',
        path: '/v1/admin/settings',
        keys: [
          'defaultModel',
          'fallbackModels',
          'totalTimeoutMs',
          'maxAttempts',
          'breakerThreshold',
          'breakerOpenMs',
          'streamEnabled',
          'rateLimitPerMinute',
        ],
      },
    });
    expect(node(missing, 'http.tools')).toMatchObject({
      status: 'off',
      configure: { where: 'env', keys: ['STEPACCESS_URL'] },
    });
  });

  it('uma dependência em baixo passa o erro a quem a usa', () => {
    const t = topology({
      runtime: runtime({
        checks: {
          database: { status: 'failed', latencyMs: 3000, detail: 'TimeoutError' },
          stepAccess: { status: 'failed', latencyMs: 5, detail: 'HTTP 500' },
          openRouter: OK,
        },
      }),
    });
    expect(node(t, 'external.postgres')).toMatchObject({
      status: 'error',
      summary: 'Falhou: TimeoutError',
    });
    expect(node(t, 'adapter.pgMemoryStore').status).toBe('error');
    expect(node(t, 'core.memories').status).toBe('error');
    expect(node(t, 'port.access').status).toBe('error');
  });

  it('créditos do OpenRouter perto do limite dão um aviso', () => {
    const t = topology({
      runtime: runtime({
        checks: {
          database: OK,
          stepAccess: OK,
          openRouter: { ...OK, credits: { usage: 95, limit: 100 } },
        },
      }),
    });
    expect(node(t, 'external.openrouter')).toMatchObject({
      status: 'warning',
      summary: 'Créditos quase no limite (95 de 100 USD)',
    });
  });

  it('modelos: mostra a cadeia, conta os pedidos servidos por recurso e avisa', () => {
    const chained = {
      ...sentiment,
      fallbackModels: ['openai/gpt-4.1-mini'],
      requests: 10,
      fallbacks: 1,
    };
    const t = topology({ tools: [chained, reply] });
    expect(node(t, 'adapter.llm')).toMatchObject({
      status: 'ok',
      details: { chain: 'gemini-2.5-flash → gpt-4.1-mini', fallbacks: 1, openBreakers: 0 },
    });
    expect(node(t, 'tool.sentiment').details).toMatchObject({ fallbacks: 1 });

    const many = topology({
      tools: [
        { ...chained, fallbacks: 3 },
        { ...chained, name: 'diagnostic', model: 'x/outro', fallbacks: 3 },
      ],
    });
    expect(node(many, 'adapter.llm')).toMatchObject({
      status: 'warning',
      details: { chain: 'várias', fallbacks: 6 },
    });

    const open = topology({
      breakers: [{ model: 'google/gemini-2.5-flash', openSince: 'a', openUntil: 'b' }],
    });
    expect(node(open, 'adapter.llm')).toMatchObject({
      status: 'warning',
      summary: 'Disjuntor aberto: gemini-2.5-flash',
    });
  });

  it('ferramentas: desligada, sem implementação e com muitas falhas', () => {
    const t = topology({
      tools: [
        { ...sentiment, enabled: false },
        reply,
        { ...sentiment, name: 'diagnostic', requests: 10, failed: 3 },
      ],
    });
    expect(node(t, 'tool.sentiment')).toMatchObject({
      status: 'off',
      configure: { where: 'admin_api', path: '/v1/admin/tools/sentiment' },
    });
    expect(node(t, 'tool.reply')).toMatchObject({ status: 'off', label: 'reply' });
    expect(hasEdge(t, 'tool.reply', 'core.engine')).toBe(false);
    expect(node(t, 'tool.diagnostic')).toMatchObject({
      status: 'warning',
      summary: '30% dos pedidos falharam desde o arranque',
    });
    expect(t.overall).toBe('warning');
  });
});
