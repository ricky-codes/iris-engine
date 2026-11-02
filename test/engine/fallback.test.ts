import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/engine/breaker.js';
import { createEngine } from '../../src/engine/engine.js';
import { EngineError } from '../../src/engine/errors.js';
import type { LlmProvider, LlmRequest } from '../../src/engine/llm.js';
import { callModel, runTool, type PreparedRun } from '../../src/engine/run.js';
import type { ToolDefinition } from '../../src/engine/tool.js';
import type { CostEvent } from '../../src/engine/usage.js';
import { diagnosticTool } from '../../src/tools/diagnostic.js';
import { fakeAccess, fakeStore } from './fakes.js';

const tool = diagnosticTool as unknown as ToolDefinition;
const OK = '{"reply":"Olá!"}';
const BAD = 'não é json';
const down = () => new EngineError('provider_unavailable', 'Indisponível.');
const slow = () => new EngineError('timeout', 'Demorou.');

type Step = string | (() => EngineError);

/**
 * Um fornecedor falso que responde por modelo, pela ordem do guião (o último passo repete-se).
 * Cada chamada avança o relógio `ms` e custa 0,001 USD quando há resposta.
 */
function scripted(script: Record<string, Step[]>, clock = { now: 0 }, ms = 100) {
  const calls: LlmRequest[] = [];
  const used = new Map<string, number>();
  const llm: LlmProvider = {
    complete: async (req) => {
      calls.push(req);
      const steps = script[req.model] ?? [down];
      const n = used.get(req.model) ?? 0;
      used.set(req.model, n + 1);
      const step = steps[Math.min(n, steps.length - 1)] ?? down;
      clock.now += ms;
      if (typeof step === 'function') throw step();
      return {
        text: step,
        model: `${req.model}-servido`,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      };
    },
  };
  return { llm, calls, clock };
}

function prepared(model: string, fallbackModels: string[], timeoutMs = 20_000): PreparedRun {
  return {
    settings: {
      model,
      fallbackModels,
      temperature: 0.2,
      maxOutputTokens: 300,
      timeoutMs,
      enabled: true,
      systemPrompt: undefined,
    },
    memories: { org: [], user: [] },
    system: 'S',
    user: 'U',
    schema: {},
  };
}

describe('cadeia de modelos (callModel)', () => {
  it.each([
    ['indisponível', down, 'provider_unavailable'],
    ['tempo esgotado', slow, 'timeout'],
  ] as const)('principal %s: passa logo ao recurso, que responde', async (_label, fail, reason) => {
    const f = scripted({ a: [fail], b: [OK] });
    const out = await callModel(f.llm, tool, prepared('a', ['b']));
    expect(out.result).toEqual({ reply: 'Olá!' });
    expect(out.attempts.map((x) => [x.requestedModel, x.reason, x.fallback])).toEqual([
      ['a', reason, false],
      ['b', 'ok', true],
    ]);
    expect(f.calls.map((c) => c.model)).toEqual(['a', 'b']);
  });

  it('resposta inválida duas vezes no principal, depois o recurso responde', async () => {
    const f = scripted({ a: [BAD, BAD], b: [OK] });
    const out = await callModel(f.llm, tool, prepared('a', ['b']));
    expect(out.result).toEqual({ reply: 'Olá!' });
    expect(out.attempts.map((x) => x.reason)).toEqual(['invalid_output', 'invalid_output', 'ok']);
    expect(out.attempts.map((x) => x.text)).toEqual([BAD, BAD, OK]);
  });

  it('a cadeia inteira falha: devolve o erro da última tentativa', async () => {
    const f = scripted({ a: [BAD, BAD], b: [down] });
    const out = await callModel(f.llm, tool, prepared('a', ['b']));
    expect(out.result).toBeUndefined();
    expect(out.error).toMatchObject({ code: 'provider_unavailable' });
  });

  it('cada chamada usa o timeoutMs da ferramenta, cortado pelo que resta do orçamento', async () => {
    const clock = { now: 0 };
    const f = scripted({ a: [slow], b: [OK] }, clock, 7000);
    await callModel(f.llm, tool, prepared('a', ['b'], 20_000), {
      totalTimeoutMs: 10_000,
      now: () => clock.now,
    });
    expect(f.calls.map((c) => c.timeoutMs)).toEqual([10_000, 3000]);
  });

  it('o orçamento total corta a cadeia: não começa uma tentativa com menos de 1 s', async () => {
    const clock = { now: 0 };
    const f = scripted({ a: [slow], b: [slow], c: [OK] }, clock, 4600);
    const out = await callModel(f.llm, tool, prepared('a', ['b', 'c']), {
      totalTimeoutMs: 10_000,
      now: () => clock.now,
    });
    // a: 4,6 s; b: 4,6 s; sobram 0,8 s → c não chega a ser chamado.
    expect(f.calls.map((c) => c.model)).toEqual(['a', 'b']);
    expect(out.result).toBeUndefined();
    expect(out.error).toMatchObject({ code: 'timeout' });
  });

  it('um erro inesperado do fornecedor não é escondido pela cadeia', async () => {
    const llm: LlmProvider = {
      complete: async () => {
        throw new Error('bug');
      },
    };
    await expect(callModel(llm, tool, prepared('a', ['b']))).rejects.toThrow('bug');
  });
});

describe('disjuntor', () => {
  it('abre depois de 3 falhas seguidas, salta o modelo e fecha ao fim de 60 s', async () => {
    const clock = { now: 0 };
    const breaker = new CircuitBreaker(() => clock.now);
    const f = scripted({ a: [down], b: [OK] }, clock, 10);
    const run = () =>
      callModel(f.llm, tool, prepared('a', ['b']), { breaker, now: () => clock.now });

    for (let i = 0; i < 3; i++) await run();
    expect(breaker.isOpen('a')).toBe(true);
    expect(breaker.open()).toMatchObject([{ model: 'a' }]);

    const skipped = await run();
    expect(skipped.attempts.map((x) => [x.requestedModel, x.reason])).toEqual([
      ['a', 'skipped_breaker'],
      ['b', 'ok'],
    ]);
    expect(f.calls.filter((c) => c.model === 'a')).toHaveLength(3);

    clock.now += 60_000;
    expect(breaker.isOpen('a')).toBe(false);
    await run();
    expect(f.calls.filter((c) => c.model === 'a')).toHaveLength(4);
    // Voltou a falhar: abre logo outra vez.
    expect(breaker.isOpen('a')).toBe(true);
  });

  it('uma resposta fecha o disjuntor e recomeça a contagem', () => {
    const breaker = new CircuitBreaker(() => 0);
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    breaker.recordSuccess('a');
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    expect(breaker.isOpen('a')).toBe(false);
  });

  it('nunca salta o último modelo que resta na cadeia', async () => {
    const clock = { now: 0 };
    const breaker = new CircuitBreaker(() => clock.now);
    for (let i = 0; i < 3; i++) breaker.recordFailure('a');
    const f = scripted({ a: [OK] }, clock);
    const out = await callModel(f.llm, tool, prepared('a', []), { breaker, now: () => clock.now });
    expect(out.result).toEqual({ reply: 'Olá!' });
    expect(breaker.isOpen('a')).toBe(false);
  });
});

describe('runTool com modelos de recurso', () => {
  const REQ = {
    orgId: '00DAAAAAAAAAAAAAAA',
    userId: '005AAAAAAAAAAAAAAA',
    input: { message: 'Olá' },
    requestId: 'r1',
  };

  it('resposta do recurso: fallback no meta, modelo que respondeu e custo de todas as tentativas', async () => {
    const costs: CostEvent[] = [];
    const f = scripted({ a: [BAD, BAD], b: [OK] });
    const out = await runTool(
      {
        access: fakeAccess().access,
        ...fakeStore(undefined, { model: 'a', fallbackModels: ['b'] }),
        llm: f.llm,
        defaultModel: 'a',
        usage: { report: (e) => costs.push(e) },
      },
      tool,
      REQ,
    );
    expect(out.meta).toMatchObject({ model: 'b-servido', fallback: true, attempts: 3 });
    expect(out.meta.costUsd).toBeCloseTo(0.003);
    expect(costs).toMatchObject([{ outcome: 'success', model: 'b-servido', attempts: 3 }]);
    expect(costs[0]?.costUsd).toBeCloseTo(0.003);
  });

  it('a cadeia inteira falha: lança o erro da última tentativa com o custo total', async () => {
    const costs: CostEvent[] = [];
    const f = scripted({ a: [BAD, BAD], b: [down] });
    const err: unknown = await runTool(
      {
        access: fakeAccess().access,
        ...fakeStore(undefined, { model: 'a', fallbackModels: ['b'] }),
        llm: f.llm,
        defaultModel: 'a',
        usage: { report: (e) => costs.push(e) },
      },
      tool,
      REQ,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'provider_unavailable' });
    expect((err as EngineError).costUsd).toBeCloseTo(0.002);
    // Houve respostas pagas: o custo vai para o StepAccess como invalid_model_output.
    expect(costs).toMatchObject([
      { outcome: 'invalid_model_output', model: 'a-servido', attempts: 3 },
    ]);
  });

  it('só falhas do fornecedor: sem custo, e nada enviado ao StepAccess', async () => {
    const costs: CostEvent[] = [];
    const f = scripted({ a: [down], b: [slow] });
    await expect(
      runTool(
        {
          access: fakeAccess().access,
          ...fakeStore(undefined, { model: 'a', fallbackModels: ['b'] }),
          llm: f.llm,
          defaultModel: 'a',
          usage: { report: (e) => costs.push(e) },
        },
        tool,
        REQ,
      ),
    ).rejects.toMatchObject({ code: 'timeout', costUsd: undefined });
    expect(costs).toHaveLength(0);
  });
});

describe('motor com modelos de recurso', () => {
  it('usa os modelos de recurso do motor, emite uma chamada por tentativa e mostra os disjuntores', async () => {
    const clock = { now: 0 };
    const f = scripted({ m: [down], r: [OK] }, clock, 10);
    const events: { type: string }[] = [];
    const engine = createEngine({
      settings: { defaultModel: 'm', fallbackModels: ['r', 'm'] },
      tools: [tool],
      access: fakeAccess().access,
      llm: f.llm,
      ...fakeStore(),
      now: () => clock.now,
      onEvent: (e) => events.push(e),
    });
    expect(engine.settings.fallbackModels).toEqual(['r']);
    for (let i = 0; i < 3; i++) {
      const out = await engine.run('diagnostic', {
        orgId: 'o',
        userId: 'u',
        input: { message: 'x' },
      });
      expect(out.meta.fallback).toBe(true);
    }
    expect(events.filter((e) => e.type === 'model_call')).toHaveLength(6);
    expect(engine.openBreakers()).toMatchObject([{ model: 'm' }]);

    // O playground pode trocar a cadeia, e as tentativas dizem o motivo de cada uma.
    const trial = await engine.trial(
      'diagnostic',
      { orgId: 'o', userId: 'u', input: { message: 'x' } },
      {
        fallbackModels: ['r'],
      },
    );
    expect(trial.attempts.map((a) => [a.requestedModel, a.reason, a.fallback])).toEqual([
      ['m', 'skipped_breaker', false],
      ['r', 'ok', true],
    ]);
    // O playground não entra nas métricas.
    expect(events.filter((e) => e.type === 'model_call')).toHaveLength(6);
  });

  it('recusa arrancar com mais de 3 modelos de recurso ou um teto de tempo fora dos limites', () => {
    const base = {
      tools: [tool],
      access: fakeAccess().access,
      llm: scripted({}).llm,
      ...fakeStore(),
    };
    expect(() =>
      createEngine({
        ...base,
        settings: { defaultModel: 'm', fallbackModels: ['a', 'b', 'c', 'd'] },
      }),
    ).toThrow(/modelos de recurso/);
    expect(() =>
      createEngine({ ...base, settings: { defaultModel: 'm', totalTimeoutMs: 500 } }),
    ).toThrow(/totalTimeoutMs/);
  });
});
