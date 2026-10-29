import { describe, expect, it } from 'vitest';
import { createEngine, type EngineEvent } from '../../src/engine/engine.js';
import { EngineError } from '../../src/engine/errors.js';
import type { ToolDefinition } from '../../src/engine/tool.js';
import { diagnosticTool } from '../../src/tools/diagnostic.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeStore } from './fakes.js';

const tool = diagnosticTool as unknown as ToolDefinition;
const REQ = {
  orgId: '00DAAAAAAAAAAAAAAA',
  userId: '005AAAAAAAAAAAAAAA',
  input: { message: 'Olá' },
};
const OK = '{"reply":"Olá!"}';

describe('createEngine', () => {
  it('lista as ferramentas e encontra-as pelo nome', () => {
    const engine = fakeEngine([tool]);
    expect(engine.tools().map((t) => t.name)).toEqual(['diagnostic']);
    expect(engine.tool('diagnostic')).toBe(tool);
    expect(engine.tool('nao_existe')).toBeUndefined();
    expect(engine.settings).toEqual({ defaultModel: 'm', maxAttempts: 2 });
  });

  it.each([
    ['nome repetido', [tool, tool], {}, /repetida/],
    ['nome inválido', [{ ...tool, name: 'Diag-1' }], {}, /nome inválido/],
    ['modelo vazio', [tool], { defaultModel: ' ' }, /defaultModel/],
    ['tentativas a mais', [tool], { defaultModel: 'm', maxAttempts: 6 }, /maxAttempts/],
    ['tentativas a zero', [tool], { defaultModel: 'm', maxAttempts: 0 }, /maxAttempts/],
  ])('recusa arrancar com %s', (_label, tools, settings, message) => {
    expect(() =>
      createEngine({
        settings: { defaultModel: 'm', ...settings },
        tools,
        access: fakeAccess().access,
        llm: fakeLlm(OK).llm,
        ...fakeStore(),
      }),
    ).toThrow(message);
  });
});

describe('Engine.run', () => {
  it('corre a ferramenta e devolve o resultado validado', async () => {
    const engine = fakeEngine([tool], { llm: fakeLlm(OK).llm });
    await expect(engine.run('diagnostic', REQ)).resolves.toMatchObject({
      result: { reply: 'Olá!' },
      meta: { attempts: 1 },
    });
  });

  it('ferramenta desconhecida dá unknown_tool, sem verificar acesso', async () => {
    const access = fakeAccess();
    const engine = fakeEngine([tool], { access: access.access });
    await expect(engine.run('nao_existe', REQ)).rejects.toMatchObject({ code: 'unknown_tool' });
    expect(access.calls).toHaveLength(0);
  });

  it.each([
    ['campo em falta', {}, 'input.message'],
    ['tipo errado', { message: 42 }, 'input.message'],
    ['campo a mais', { message: 'Olá', extra: true }, 'input.extra'],
  ])('valida a entrada (%s) antes de gastar acesso ou modelo', async (_label, input, path) => {
    const access = fakeAccess();
    const llm = fakeLlm(OK);
    const engine = fakeEngine([tool], { access: access.access, llm: llm.llm });
    const err: unknown = await engine.run('diagnostic', { ...REQ, input }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'invalid_request' });
    expect((err as EngineError).details.map((d) => d.path)).toContain(path);
    expect(access.calls).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('respeita maxAttempts', async () => {
    const llm = fakeLlm('não é json');
    const engine = createEngine({
      settings: { defaultModel: 'm', maxAttempts: 3 },
      tools: [tool],
      access: fakeAccess().access,
      llm: llm.llm,
      ...fakeStore(),
    });
    await expect(engine.run('diagnostic', REQ)).rejects.toMatchObject({
      code: 'invalid_model_output',
    });
    expect(llm.requests).toHaveLength(3);
  });

  it('emite um evento no fim, com sucesso ou com o código do erro', async () => {
    const events: EngineEvent[] = [];
    const ok = fakeEngine([tool], { llm: fakeLlm(OK).llm, onEvent: (e) => events.push(e) });
    await ok.run('diagnostic', { ...REQ, requestId: 'r1' });
    const denied = fakeEngine([tool], {
      access: fakeAccess(new EngineError('quota_exceeded', 'Limite.')).access,
      onEvent: (e) => events.push(e),
    });
    await expect(denied.run('diagnostic', REQ)).rejects.toThrow();

    expect(events).toMatchObject([
      {
        type: 'run_completed',
        tool: 'diagnostic',
        requestId: 'r1',
        orgId: REQ.orgId,
        model: 'm',
        attempts: 1,
        inputTokens: 10,
      },
      { type: 'run_failed', tool: 'diagnostic', code: 'quota_exceeded' },
    ]);
    // Só metadados: nem a entrada nem a resposta vão no evento.
    expect(JSON.stringify(events)).not.toContain('Olá');
  });

  it('um erro de quem ouve os eventos não faz falhar o pedido', async () => {
    const engine = fakeEngine([tool], {
      llm: fakeLlm(OK).llm,
      onEvent: () => {
        throw new Error('ouvinte partido');
      },
    });
    await expect(engine.run('diagnostic', REQ)).resolves.toMatchObject({
      result: { reply: 'Olá!' },
    });
  });
});

describe('Engine.preview e Engine.trial', () => {
  it('preview monta o prompt sem verificar acesso nem chamar o modelo', async () => {
    const access = fakeAccess();
    const llm = fakeLlm(OK);
    const engine = fakeEngine([tool], { access: access.access, llm: llm.llm });
    const prepared = await engine.preview('diagnostic', REQ, { systemPrompt: 'Outro prompt.' });
    expect(prepared).toMatchObject({ system: 'Outro prompt.', user: 'Olá' });
    expect(access.calls).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('trial corre mesmo com a ferramenta desligada e só verifica acesso se pedido', async () => {
    const access = fakeAccess();
    const engine = createEngine({
      settings: { defaultModel: 'm' },
      tools: [tool],
      access: access.access,
      llm: fakeLlm(OK).llm,
      ...fakeStore(undefined, { enabled: false }),
    });
    await expect(engine.run('diagnostic', REQ)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(engine.trial('diagnostic', REQ, { model: 'outro' })).resolves.toMatchObject({
      result: { reply: 'Olá!' },
      prepared: { settings: { model: 'outro' } },
    });
    expect(access.calls).toHaveLength(0);
    await engine.trial('diagnostic', REQ, { checkAccess: true });
    expect(access.calls).toHaveLength(1);
  });
});
