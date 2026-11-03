import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { defineTool, type ToolDefinition } from '../../src/engine/tool.js';
import { EngineError } from '../../src/engine/errors.js';
import { diagnosticTool } from '../../src/tools/diagnostic.js';
import { createEngine, type EngineSettings } from '../../src/engine/engine.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeStore } from './fakes.js';

const REQ = { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA' };
const diag = diagnosticTool as unknown as ToolDefinition;

function collector() {
  const events: string[] = [];
  return {
    events,
    handlers: {
      onStart: () => events.push('start'),
      onDelta: (t: string) => events.push(`delta:${t}`),
      onReset: () => events.push('reset'),
    },
  };
}

describe('Engine.run com streaming', () => {
  it('envia o texto à medida que nasce e devolve o resultado validado', async () => {
    const { events, handlers } = collector();
    const engine = fakeEngine([diag], { llm: fakeLlm('{"reply":"Olá mundo"}').llm });
    const out = await engine.run('diagnostic', {
      ...REQ,
      input: { message: 'oi' },
      stream: handlers,
    });
    expect(out.result).toEqual({ reply: 'Olá mundo' });
    expect(events[0]).toBe('start');
    expect(
      events
        .filter((e) => e.startsWith('delta:'))
        .map((e) => e.slice(6))
        .join(''),
    ).toBe('Olá mundo');
    expect(events.filter((e) => e.startsWith('delta:')).length).toBeGreaterThan(1);
  });

  it('anula o texto enviado quando a resposta é inválida e há nova tentativa', async () => {
    const { events, handlers } = collector();
    // 1.ª tentativa: o campo sai mas há um campo a mais (inválido); 2.ª: válida.
    const llm = fakeLlm('{"reply":"errado","extra":1}', '{"reply":"certo"}');
    const engine = fakeEngine([diag], { llm: llm.llm });
    const out = await engine.run('diagnostic', {
      ...REQ,
      input: { message: 'oi' },
      stream: handlers,
    });
    expect(out.result).toEqual({ reply: 'certo' });
    const reset = events.indexOf('reset');
    expect(reset).toBeGreaterThan(0);
    const after = events
      .slice(reset + 1)
      .filter((e) => e.startsWith('delta:'))
      .map((e) => e.slice(6))
      .join('');
    expect(after).toBe('certo');
  });

  it('recusa stream numa ferramenta que não o suporta, antes de gastar utilização', async () => {
    const plain = defineTool({ ...diagnosticTool, name: 'plain' });
    Reflect.deleteProperty(plain, 'stream');
    const engine = fakeEngine([plain as unknown as ToolDefinition]);
    await expect(
      engine.run('plain', { ...REQ, input: { message: 'oi' }, stream: collector().handlers }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('sem stream, o motor comporta-se como antes (o fornecedor nem recebe onText)', async () => {
    const llm = fakeLlm('{"reply":"ok"}');
    const engine = fakeEngine([diag], { llm: llm.llm });
    await engine.run('diagnostic', { ...REQ, input: { message: 'oi' } });
    expect(llm.requests[0]?.onText).toBeUndefined();
  });

  it('uma falha do fornecedor chega como erro, sem resultado', async () => {
    const engine = fakeEngine([diag], {
      llm: fakeLlm(new EngineError('provider_unavailable', 'x')).llm,
    });
    await expect(
      engine.run('diagnostic', { ...REQ, input: { message: 'oi' }, stream: collector().handlers }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('o registo recusa um stream.field que não seja texto da saída', () => {
    const bad = defineTool({
      ...diagnosticTool,
      name: 'bad',
      output: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
      stream: { field: 'n' },
    }) as unknown as ToolDefinition;
    expect(() => fakeEngine([bad])).toThrow(/stream\.field/);
  });
});

describe('disjuntor configurável', () => {
  const make = (settings: Partial<EngineSettings>, llm = fakeLlm('{}').llm) =>
    createEngine({
      settings: { defaultModel: 'm', ...settings },
      tools: [diag],
      access: fakeAccess().access,
      llm,
      ...fakeStore(),
    });

  it('abre ao fim de breakerThreshold falhas seguidas', async () => {
    const engine = make(
      { breakerThreshold: 1, breakerOpenMs: 5000 },
      fakeLlm(new EngineError('provider_unavailable', 'x')).llm,
    );
    expect(engine.openBreakers()).toEqual([]);
    await expect(engine.run('diagnostic', { ...REQ, input: { message: 'oi' } })).rejects.toThrow();
    expect(engine.openBreakers()).toMatchObject([{ model: 'm' }]);
  });

  it.each([
    [{ breakerThreshold: 0 }, /breakerThreshold/],
    [{ breakerThreshold: 21 }, /breakerThreshold/],
    [{ breakerOpenMs: 999 }, /breakerOpenMs/],
    [{ breakerOpenMs: 3_600_001 }, /breakerOpenMs/],
  ])('recusa %j', (settings, message) => {
    expect(() => make(settings)).toThrow(message);
  });
});
