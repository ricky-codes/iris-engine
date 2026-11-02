import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { statusReport } from '../../src/admin/status.js';
import {
  buildTopology,
  type BreakerFact,
  type CheckFact,
  type RuntimeFacts,
  type ToolFact,
  type Topology,
} from '../../src/admin/topology.js';
import {
  NoopAlertSink,
  RETRY_DELAYS_MS,
  WebhookAlertSink,
  signature,
} from '../../src/adapters/webhook-alert-sink.js';
import { AlertMonitor, RESOLVE_AFTER } from '../../src/alerts/monitor.js';
import type { Alert, DeliveryResult } from '../../src/alerts/types.js';
import { MetricsWindow } from '../../src/alerts/window.js';
import { Metrics } from '../../src/engine/metrics.js';
import { fakeFetch, json } from '../engine/fakes.js';

const MIN = 60_000;
const OK: CheckFact = { status: 'ok', latencyMs: 5 };

function runtime(checks: Partial<RuntimeFacts['checks']> = {}): RuntimeFacts {
  return {
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
    routes: { tools: true, compat: true, memories: true },
    checks: {
      database: OK,
      stepAccess: OK,
      openRouter: { ...OK, credits: { usage: 1, limit: 100 } },
      ...checks,
    },
  };
}

const reply: ToolFact = {
  name: 'reply',
  implemented: true,
  version: 1,
  enabled: true,
  model: 'google/gemini-2.5-flash',
  modelSource: 'default',
  fallbackModels: [],
  prompt: { source: 'code', version: null },
  requests: 0,
  failed: 0,
  fallbacks: 0,
};

/** Um mundo falso: relógio, métricas, topologia e disjuntores que os testes mudam à vontade. */
function world() {
  const clock = { now: Date.parse('2026-11-02T10:00:00.000Z') };
  const metrics = new Metrics(() => new Date(clock.now));
  const state = { rt: runtime(), breakers: [] as BreakerFact[] };
  const sent: Alert[] = [];
  const sink = {
    configured: true,
    send: async (alert: Alert): Promise<DeliveryResult> => {
      sent.push(alert);
      return { delivered: true, status: 200, durationMs: 1, attempts: 1, error: null };
    },
  };
  const monitor: AlertMonitor = new AlertMonitor({
    sink,
    format: 'iris',
    topology: async (): Promise<Topology> =>
      buildTopology({
        runtime: state.rt,
        tools: [reply],
        breakers: state.breakers,
        memories: { org: 0, user: 0, limits: { chars: 500, perOrg: 50, perUser: 20 } },
        alerts: monitor.facts(),
      }),
    metrics,
    breakers: () => state.breakers,
    service: { name: 'iris-engine', environment: 'production' },
    consoleUrl: 'https://stephub.exemplo.pt/iris',
    windowMs: 15 * MIN,
    repeatMs: 4 * 60 * MIN,
    now: () => clock.now,
  });
  /** Avança o relógio e avalia, à espera dos envios. */
  const tick = async (ms = MIN) => {
    clock.now += ms;
    await monitor.evaluate();
    await monitor.flush();
  };
  const record = (n: number, errorCode?: string, fallback = false) => {
    for (let i = 0; i < n; i++) {
      metrics.record({ tool: 'reply', errorCode, durationMs: 10, fallback });
    }
  };
  return { clock, metrics, state, sent, monitor, tick, record };
}

describe('regras e ciclo de vida', () => {
  it('um serviço externo em erro dispara uma vez e só resolve ao fim de 2 avaliações limpas', async () => {
    const w = world();
    await w.tick();
    expect(w.sent).toHaveLength(0);

    w.state.rt = runtime({
      database: { status: 'failed', latencyMs: 3000, detail: 'TimeoutError' },
    });
    await w.tick();
    expect(w.sent).toMatchObject([
      {
        key: 'external.postgres.error',
        state: 'firing',
        severity: 'error',
        title: 'Postgres não funciona',
        summary: 'Falhou: TimeoutError',
        nodeId: 'external.postgres',
        consoleUrl: 'https://stephub.exemplo.pt/iris',
      },
    ]);
    // Os módulos que só herdam o erro (adaptadores, interfaces, memórias) não repetem o alerta.
    expect(w.monitor.view().active.map((a) => a.key)).toEqual(['external.postgres.error']);

    await w.tick();
    expect(w.sent).toHaveLength(1);

    w.state.rt = runtime();
    await w.tick();
    expect(w.sent).toHaveLength(1);
    // A condição volta antes da segunda avaliação limpa: nada de oscilar.
    w.state.rt = runtime({
      database: { status: 'failed', latencyMs: 3000, detail: 'TimeoutError' },
    });
    await w.tick();
    expect(w.sent).toHaveLength(1);

    w.state.rt = runtime();
    for (let i = 0; i < RESOLVE_AFTER; i++) await w.tick();
    expect(w.sent.map((a) => a.state)).toEqual(['firing', 'resolved']);
    expect(w.sent[1]).toMatchObject({
      key: 'external.postgres.error',
      startedAt: w.sent[0]?.startedAt,
    });
    expect(w.monitor.view().active).toEqual([]);
    expect(w.monitor.view().recent.map((a) => a.state)).toEqual(['resolved', 'firing']);
  });

  it('configuração em falta: o motor em erro dá alerta', async () => {
    const w = world();
    w.state.rt = {
      ...runtime(),
      engine: { ready: false, missing: ['OPENROUTER_API_KEY'], defaultModel: 'm', maxAttempts: 2 },
    };
    await w.tick();
    expect(w.sent).toMatchObject([
      { key: 'core.engine.error', summary: 'Desligado: falta OPENROUTER_API_KEY' },
    ]);
  });

  it('créditos: aviso a 90%, erro a 100% (volta a enviar ao mudar de gravidade) e resolve', async () => {
    const w = world();
    const credits = (usage: number) =>
      runtime({ openRouter: { ...OK, credits: { usage, limit: 50 } } });
    w.state.rt = credits(45);
    await w.tick();
    w.state.rt = credits(50);
    await w.tick();
    expect(w.sent.map((a) => [a.key, a.severity])).toEqual([
      ['openrouter.credits', 'warning'],
      ['openrouter.credits', 'error'],
    ]);
    expect(w.sent[1]?.details).toEqual({ usedUsd: 50, limitUsd: 50 });
    w.state.rt = credits(10);
    await w.tick();
    await w.tick();
    expect(w.sent.at(-1)).toMatchObject({ key: 'openrouter.credits', state: 'resolved' });
  });

  it('ferramenta com falhas na janela: aviso a 20%, erro a 50%; recusas de licença não contam', async () => {
    const w = world();
    await w.tick();
    w.record(8);
    w.record(2, 'provider_unavailable');
    w.record(10, 'access_denied');
    await w.tick();
    expect(w.sent).toHaveLength(0); // 2 em 20 = 10%: abaixo do aviso.

    w.record(2, 'timeout');
    w.record(1, 'provider_unavailable');
    await w.tick();
    expect(w.sent).toMatchObject([
      {
        key: 'tool.reply.failure_rate',
        severity: 'warning',
        title: 'Ferramenta reply com 22% de falhas',
        summary:
          '5 de 23 pedidos falharam nos últimos 15 min (provider_unavailable: 3, timeout: 2).',
        nodeId: 'tool.reply',
        details: { requests: 23, failed: 5, errorsByCode: { provider_unavailable: 3, timeout: 2 } },
      },
    ]);

    w.record(30, 'provider_unavailable');
    await w.tick();
    expect(w.sent.at(-1)).toMatchObject({ key: 'tool.reply.failure_rate', severity: 'error' });

    // Passada a janela sem novos pedidos, as falhas saem da conta e o alerta resolve.
    await w.tick(16 * MIN);
    await w.tick();
    expect(w.sent.at(-1)).toMatchObject({ key: 'tool.reply.failure_rate', state: 'resolved' });
  });

  it('muitos pedidos servidos por modelos de recurso e disjuntor aberto há mais de 5 min', async () => {
    const w = world();
    await w.tick();
    w.record(6, undefined, true);
    w.record(4);
    w.state.breakers = [
      {
        model: 'google/gemini-2.5-flash',
        openSince: new Date(w.clock.now - 2 * MIN).toISOString(),
        openUntil: 'x',
      },
    ];
    await w.tick();
    expect(w.sent.map((a) => a.key)).toEqual(['llm.fallback_rate']);
    expect(w.sent[0]).toMatchObject({
      severity: 'warning',
      details: { requests: 10, fallbacks: 6 },
    });

    await w.tick(4 * MIN);
    expect(w.sent.map((a) => a.key)).toEqual([
      'llm.fallback_rate',
      'llm.breaker.google/gemini-2.5-flash',
    ]);
  });

  it('enquanto se mantém, envia um lembrete a cada ALERT_REPEAT_MS', async () => {
    const w = world();
    w.state.rt = runtime({ stepAccess: { status: 'failed', latencyMs: 9, detail: 'HTTP 500' } });
    await w.tick();
    await w.tick(3 * 60 * MIN);
    expect(w.sent).toHaveLength(1);
    await w.tick(61 * MIN);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toMatchObject({
      key: 'external.stepaccess.error',
      state: 'firing',
      startedAt: w.sent[0]?.startedAt,
    });
    expect(w.sent[1]?.sentAt).not.toBe(w.sent[0]?.sentAt);
  });

  it('só avalia a instância com o bloqueio; sem bloqueio configurado, avalia sempre', async () => {
    const metrics = new Metrics();
    let topologyCalls = 0;
    const base = {
      sink: new NoopAlertSink(),
      format: null,
      topology: async () => {
        topologyCalls++;
        return buildTopology({
          runtime: runtime(),
          tools: [],
          breakers: [],
          memories: { org: 0, user: 0, limits: { chars: 500, perOrg: 50, perUser: 20 } },
          alerts: { configured: false, format: null, active: 0, lastSentAt: null, lastError: null },
        });
      },
      metrics,
      breakers: () => [],
      service: { name: 'iris-engine', environment: 'test' },
      windowMs: 15 * MIN,
      repeatMs: 60 * MIN,
    };
    const follower = new AlertMonitor({ ...base, leader: { acquire: async () => false } });
    expect(await follower.evaluate()).toBe(false);
    expect(topologyCalls).toBe(0);
    expect(await new AlertMonitor(base).evaluate()).toBe(true);
    expect(topologyCalls).toBe(1);
  });

  it('um alerta nunca leva conteúdo, ids de org ou de utilizador, nem mensagens do fornecedor', async () => {
    const w = world();
    await w.tick();
    // Métricas com erros: só ferramenta, código e tempo chegam às métricas.
    w.record(5, 'provider_unavailable');
    w.record(5, 'invalid_model_output');
    w.state.rt = runtime({ openRouter: { status: 'failed', latencyMs: 9, detail: 'HTTP 402' } });
    await w.tick();
    expect(w.sent.length).toBeGreaterThan(0);
    const allowed = new Set([
      'service',
      'environment',
      'key',
      'state',
      'severity',
      'title',
      'summary',
      'nodeId',
      'details',
      'startedAt',
      'sentAt',
      'consoleUrl',
    ]);
    for (const alert of w.sent) {
      for (const key of Object.keys(alert)) expect(allowed.has(key), key).toBe(true);
      const text = JSON.stringify(alert);
      expect(text).not.toMatch(/00D[A-Za-z0-9]{15}|005[A-Za-z0-9]{15}/);
      expect(text).not.toMatch(/"(input|prompt|content|orgId|userId|message|text)"/);
      for (const v of Object.values(alert.details)) {
        expect(['number', 'string', 'boolean', 'object']).toContain(typeof v);
      }
    }
  });
});

describe('janela por diferenças', () => {
  const snap = (requests: number, failed: number, fallbacks = 0) => {
    const m = new Metrics();
    for (let i = 0; i < requests - failed; i++)
      m.record({ tool: 't', errorCode: undefined, durationMs: 1, fallback: i < fallbacks });
    for (let i = 0; i < failed; i++) m.record({ tool: 't', errorCode: 'timeout', durationMs: 1 });
    return m.snapshot();
  };

  it('subtrai a fotografia mais recente que já tem pelo menos a janela', () => {
    const w = new MetricsWindow(15 * MIN);
    w.push(0, snap(0, 0));
    w.push(5 * MIN, snap(10, 1));
    w.push(10 * MIN, snap(20, 2, 1));
    expect(w.delta()).toEqual([
      { tool: 't', requests: 20, failed: 2, errorsByCode: { timeout: 2 }, fallbacks: 1 },
    ]);
    w.push(15 * MIN, snap(30, 2, 1));
    // Base: a fotografia de t=0 (exatamente 15 min antes).
    expect(w.delta()[0]).toMatchObject({ requests: 30, failed: 2 });
    w.push(20 * MIN, snap(35, 5, 3));
    // Base: t=5 min → 35-10 pedidos, 5-1 falhas.
    expect(w.delta()).toEqual([
      { tool: 't', requests: 25, failed: 4, errorsByCode: { timeout: 4 }, fallbacks: 3 },
    ]);
    expect(w.coveredMs()).toBe(15 * MIN);
  });

  it('sem fotografias, não há nada na janela', () => {
    expect(new MetricsWindow(MIN).delta()).toEqual([]);
  });
});

const ALERT: Alert = {
  service: 'iris-engine',
  environment: 'production',
  key: 'tool.reply.failure_rate',
  state: 'firing',
  severity: 'warning',
  title: 'Ferramenta reply com 35% de falhas',
  summary: '12 de 34 pedidos falharam nos últimos 15 min (provider_unavailable: 9, timeout: 3).',
  nodeId: 'tool.reply',
  details: { requests: 34, failed: 12, errorsByCode: { provider_unavailable: 9, timeout: 3 } },
  startedAt: '2026-11-02T10:00:00.000Z',
  sentAt: '2026-11-02T10:00:00.000Z',
  consoleUrl: 'https://stephub.exemplo.pt/iris',
};
const SECRET = 'k'.repeat(40);

describe('WebhookAlertSink', () => {
  it('faz POST JSON assinado, com uma assinatura que o destino consegue verificar', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const sink = new WebhookAlertSink(
      { url: 'https://hook.exemplo.pt/x', secret: SECRET, format: 'iris' },
      f.fn,
    );
    await expect(sink.send(ALERT)).resolves.toMatchObject({
      delivered: true,
      status: 204,
      attempts: 1,
      error: null,
    });
    const init = f.calls[0]?.init;
    const body = init?.body as string;
    expect(JSON.parse(body)).toEqual(ALERT);
    const headers = init?.headers as Record<string, string>;
    const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(headers['X-Iris-Signature']).toBe(expected);
    expect(signature(body, SECRET)).toBe(expected);
    expect(init?.method).toBe('POST');
  });

  it('formato slack: { text } com título, resumo e link', async () => {
    const f = fakeFetch(() => json(200, {}));
    await new WebhookAlertSink(
      { url: 'https://hooks.slack.com/x', secret: SECRET, format: 'slack' },
      f.fn,
    ).send(ALERT);
    expect(JSON.parse(f.calls[0]?.init?.body as string)).toEqual({
      text:
        '*[Aviso] Ferramenta reply com 35% de falhas*\n' +
        '12 de 34 pedidos falharam nos últimos 15 min (provider_unavailable: 9, timeout: 3).\n' +
        '<https://stephub.exemplo.pt/iris|Abrir a consola>',
    });
  });

  it('tenta outra vez em 5xx e falhas de rede, com espera de 1 s, 4 s e 10 s', async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 1) throw new DOMException('timeout', 'TimeoutError');
      return new Response(null, { status: n < 4 ? 503 : 200 });
    });
    const waits: number[] = [];
    const sink = new WebhookAlertSink(
      { url: 'https://hook.exemplo.pt/x', secret: SECRET, format: 'iris' },
      f.fn,
      async (ms) => {
        waits.push(ms);
      },
    );
    await expect(sink.send(ALERT)).resolves.toMatchObject({
      delivered: true,
      status: 200,
      attempts: 4,
    });
    expect(waits).toEqual(RETRY_DELAYS_MS);
    expect(RETRY_DELAYS_MS).toEqual([1000, 4000, 10_000]);
    // Cada tentativa tem o seu próprio limite de tempo.
    expect(f.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('desiste ao fim das tentativas, ou logo num 4xx, sem lançar', async () => {
    const timeouts = fakeFetch(() => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    const noWait = async () => undefined;
    await expect(
      new WebhookAlertSink(
        { url: 'https://h/x', secret: SECRET, format: 'iris' },
        timeouts.fn,
        noWait,
      ).send(ALERT),
    ).resolves.toEqual(
      expect.objectContaining({
        delivered: false,
        status: null,
        attempts: 4,
        error: 'TimeoutError',
      }),
    );

    const forbidden = fakeFetch(() => json(403, { segredo: 'não devolver' }));
    const res = await new WebhookAlertSink(
      { url: 'https://h/x', secret: SECRET, format: 'iris' },
      forbidden.fn,
      noWait,
    ).send(ALERT);
    expect(res).toEqual(
      expect.objectContaining({ delivered: false, status: 403, attempts: 1, error: 'HTTP 403' }),
    );
    expect(JSON.stringify(res)).not.toContain('segredo');
  });

  it('sem webhook: não envia, mas diz porquê', async () => {
    await expect(new NoopAlertSink().send()).resolves.toMatchObject({
      delivered: false,
      attempts: 0,
      error: 'ALERT_WEBHOOK_URL não configurado',
    });
  });
});

describe('estado', () => {
  it('o /status mostra se há webhook e quantos alertas estão ativos', () => {
    expect(
      statusReport({
        runtime: runtime(),
        tools: ['sentiment'],
        defaultModel: 'm',
        diagnosticTool: false,
        alerts: { configured: true, format: 'iris', active: 2, lastSentAt: null, lastError: null },
      }),
    ).toMatchObject({ alerts: { configured: true, active: 2 }, engine: { tools: ['sentiment'] } });
  });

  it('a falha de um envio fica no estado e no log, e um envio bem-sucedido limpa-a', async () => {
    const logs: string[] = [];
    let ok = false;
    const monitor = new AlertMonitor({
      sink: {
        configured: true,
        send: async () =>
          ok
            ? { delivered: true, status: 200, durationMs: 1, attempts: 1, error: null }
            : { delivered: false, status: 500, durationMs: 1, attempts: 4, error: 'HTTP 500' },
      },
      format: 'iris',
      topology: async () => {
        throw new Error('não usado');
      },
      metrics: new Metrics(),
      breakers: () => [],
      service: { name: 'iris-engine', environment: 'test' },
      windowMs: 15 * MIN,
      repeatMs: 60 * MIN,
      log: (msg) => logs.push(msg),
    });
    await monitor.sendTest();
    expect(monitor.facts()).toMatchObject({ lastError: 'HTTP 500', lastSentAt: null });
    expect(logs).toEqual(['alert not delivered']);
    ok = true;
    await monitor.sendTest();
    expect(monitor.facts().lastError).toBeNull();
    expect(monitor.facts().lastSentAt).not.toBeNull();
  });
});
