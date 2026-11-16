import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ToolDefinition } from '../../src/engine/tool.js';
import { tipificationTool } from '../../src/tools/tipification.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeStore } from '../engine/fakes.js';
import { buildTestApp } from '../helpers.js';

const FIELDS = [
  // De propósito fora de ordem: o dependente vem antes do campo de que depende.
  {
    name: 'SubType__c',
    label: 'Subtipo',
    controllingField: 'Type__c',
    options: [
      { value: 'Transfer', label: 'Transferência SEPA', validFor: ['Request'] },
      { value: 'CardBlock', label: 'Bloqueio de cartão', validFor: ['Request'] },
      { value: 'Fees', label: 'Comissões', validFor: ['Complaint'] },
    ],
  },
  {
    name: 'Type__c',
    label: 'Tipo',
    currentValue: 'Complaint',
    instructions: 'Reclamação só quando o cliente se queixa do serviço.',
    options: [
      { value: 'Request', label: 'Pedido', description: 'O cliente pede uma ação' },
      { value: 'Complaint', label: 'Reclamação' },
    ],
  },
  {
    name: 'Reason__c',
    label: 'Motivo',
    controllingField: 'SubType__c',
    options: [
      { value: 'Unrecognised', label: 'Operação não reconhecida', validFor: ['Transfer'] },
      { value: 'Lost', label: 'Cartão perdido', validFor: ['CardBlock'] },
    ],
  },
];

const INPUT = {
  fields: FIELDS,
  case: {
    id: '500gL00001HzOO5QAN',
    caseNumber: '00001026',
    status: 'New',
    subject: 'Movimento não reconhecido — possível fraude',
    description: 'Transferência SEPA de 1.250€ que o cliente não autorizou. Contacto: x@exemplo.pt',
    createdDate: '2026-07-19T14:35:13.000Z',
  },
  contact: { name: 'Rose Gonzalez', email: 'rose@exemplo.pt', phone: '123' },
  emailMessages: [
    {
      id: 'e1',
      incoming: true,
      messageDate: '2026-07-19T08:35:13.000Z',
      textBody: 'Detetei um movimento de 1.250€ que não reconheço. Podem bloquear?',
    },
  ],
};

type Input = Parameters<NonNullable<typeof tipificationTool.finalize>>[1];
const input = INPUT as unknown as Input;
const field = (name: string, value: string | null, confidence = 0.9) => ({
  name,
  value,
  confidence,
});
const output = (...fields: ReturnType<typeof field>[]) => ({
  fields,
  confidence: 0.8,
  summary: 'Pedido de bloqueio de uma transferência não reconhecida.',
});
const finalize = (o: ReturnType<typeof output>, threshold = 0.6) =>
  tipificationTool.finalize?.(o, input, { suggestThreshold: threshold });

describe('tipification: a mensagem para o modelo', () => {
  const msg = tipificationTool.buildUserMessage(input);

  it('os campos pela ordem das dependências, com as opções agrupadas pelo campo de que dependem', () => {
    const order = msg
      .split('\n')
      .filter((l) => l.startsWith('CAMPO '))
      .map((l) => l.split(' ')[1]);
    expect(order).toEqual(['Type__c', 'SubType__c', 'Reason__c']);
    expect(msg).toContain('CAMPO Type__c "Tipo" · valor de partida: Complaint');
    expect(msg).toContain('  Instruções: Reclamação só quando o cliente se queixa do serviço.');
    expect(msg).toContain('    - Request = Pedido — O cliente pede uma ação');
    expect(msg).toContain(
      'CAMPO SubType__c "Subtipo" (depende de Type__c) · valor de partida: (vazio)\n  Se Type__c = Request:\n    - Transfer = Transferência SEPA\n    - CardBlock = Bloqueio de cartão\n  Se Type__c = Complaint:\n    - Fees = Comissões',
    );
  });

  it('o Case e os emails sem ids nem contactos', () => {
    expect(msg).toContain('Assunto: Movimento não reconhecido — possível fraude');
    expect(msg).toContain('[cliente, 19/07/2026] Detetei um movimento');
    for (const absent of ['500gL', '@', 'Rose', '123']) expect(msg, absent).not.toContain(absent);
  });
});

describe('tipification: regras da entrada', () => {
  const issues = (fields: unknown[]) =>
    tipificationTool.validateInput?.({ ...INPUT, fields } as unknown as Input) ?? [];

  it('aceita a entrada de exemplo', () => {
    expect(issues(FIELDS)).toEqual([]);
  });

  it('recusa campos e opções repetidos, um campo que depende de si e dependências em círculo', () => {
    const opt = [{ value: 'A' }];
    expect(issues([...FIELDS, FIELDS[1]])).toContainEqual({
      path: 'fields.3.name',
      issue: 'campo repetido',
    });
    expect(issues([{ name: 'A__c', options: [{ value: 'X' }, { value: 'X' }] }])).toContainEqual({
      path: 'fields.0.options.1.value',
      issue: 'valor repetido',
    });
    expect(issues([{ name: 'A__c', controllingField: 'A__c', options: opt }])).toContainEqual({
      path: 'fields.0.controllingField',
      issue: 'um campo não depende de si próprio',
    });
    expect(
      issues([
        { name: 'A__c', controllingField: 'B__c', options: opt },
        { name: 'B__c', controllingField: 'A__c', options: opt },
      ]).map((i) => i.issue),
    ).toContain('dependências em círculo');
  });
});

describe('tipification: valores válidos', () => {
  it('check: aponta valores fora das opções, pares dependentes inválidos e campos desconhecidos', () => {
    expect(
      tipificationTool.check?.(
        output(
          field('Type__c', 'Request'),
          field('SubType__c', 'Fees'),
          field('Reason__c', 'Inventado'),
          field('Other__c', 'X'),
        ),
        input,
      ),
    ).toEqual([
      'o campo Other__c não está na lista de campos a preencher',
      '"Fees" em SubType__c não vale com Type__c = "Request"',
      '"Inventado" não é uma opção de Reason__c',
    ]);
    expect(
      tipificationTool.check?.(
        output(
          field('Type__c', 'Request'),
          field('SubType__c', 'Transfer'),
          field('Reason__c', 'Unrecognised'),
        ),
        input,
      ),
    ).toEqual([]);
  });

  it('finalize: todos os campos, pela ordem da entrada, com sugerido e mudado', () => {
    expect(
      finalize(
        output(
          field('Type__c', 'Request', 0.95),
          field('SubType__c', 'Transfer', 0.8),
          field('Reason__c', 'Unrecognised', 0.5),
        ),
      ),
    ).toEqual({
      fields: [
        {
          name: 'SubType__c',
          value: 'Transfer',
          label: 'Transferência SEPA',
          confidence: 0.8,
          suggested: true,
          changed: true,
        },
        {
          name: 'Type__c',
          value: 'Request',
          label: 'Pedido',
          confidence: 0.95,
          suggested: true,
          changed: true,
        },
        {
          name: 'Reason__c',
          value: 'Unrecognised',
          label: 'Operação não reconhecida',
          confidence: 0.5,
          // Abaixo do limiar (0,6): vai, mas não é sugerido.
          suggested: false,
          changed: true,
        },
      ],
      confidence: 0.8,
      summary: 'Pedido de bloqueio de uma transferência não reconhecida.',
      discarded: [],
    });
  });

  it('finalize: um valor inválido sai e os dependentes voltam a ser verificados', () => {
    const r = finalize(
      output(
        field('Type__c', 'Inventado'),
        field('SubType__c', 'Fees'),
        field('Reason__c', 'Lost'),
      ),
    ) as { fields: { name: string; value: string | null }[]; discarded: unknown[] };
    // Type__c inválido → fica o valor de partida (Complaint); Fees vale com Complaint;
    // Lost precisa de SubType__c = CardBlock → sai.
    expect(Object.fromEntries(r.fields.map((f) => [f.name, f.value]))).toEqual({
      SubType__c: 'Fees',
      Type__c: 'Complaint',
      Reason__c: null,
    });
    expect(r.discarded).toEqual([
      { name: 'Type__c', value: 'Inventado', reason: '"Inventado" não é uma opção de Type__c' },
      {
        name: 'Reason__c',
        value: 'Lost',
        reason: '"Lost" em Reason__c não vale com SubType__c = "Fees"',
      },
    ]);
  });

  it('finalize: o limiar vem das definições', () => {
    const o = output(field('Type__c', 'Request', 0.7));
    const suggested = (t: number) =>
      (finalize(o, t) as { fields: { name: string; suggested: boolean }[] }).fields.find(
        (f) => f.name === 'Type__c',
      )?.suggested;
    expect(suggested(0.6)).toBe(true);
    expect(suggested(0.8)).toBe(false);
  });
});

describe('POST /v1/tools/tipification', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const SECRET = 's'.repeat(40);
  const IDS = { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA' };

  async function start(...answers: string[]) {
    const llm = fakeLlm(...answers);
    app = await buildTestApp({
      engine: {
        apiSecret: SECRET,
        engine: fakeEngine([tipificationTool as unknown as ToolDefinition], {
          access: fakeAccess().access,
          llm: llm.llm,
          ...fakeStore(),
        }),
      },
    });
    const send = (payload: unknown) =>
      app!.inject({
        method: 'POST',
        url: '/v1/tools/tipification',
        headers: { authorization: `Bearer ${SECRET}` },
        payload: payload as Record<string, unknown>,
      });
    return { llm, send };
  }

  const bad = JSON.stringify(output(field('Type__c', 'Request'), field('SubType__c', 'Fees')));
  const good = JSON.stringify(output(field('Type__c', 'Request'), field('SubType__c', 'Transfer')));

  it('com um par inválido, volta a pedir e diz ao modelo o que estava errado', async () => {
    const { llm, send } = await start(bad, good);
    const res = await send({ ...IDS, ...INPUT });
    expect(res.statusCode).toBe(200);
    const result = res.json<{ result: { discarded: unknown[]; fields: { value: unknown }[] } }>()
      .result;
    expect(result.discarded).toEqual([]);
    expect(result.fields.map((f) => f.value)).toEqual(['Transfer', 'Request', null]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.user).toContain(
      'A TUA RESPOSTA ANTERIOR FOI RECUSADA. Corrige estes problemas:\n- "Fees" em SubType__c não vale com Type__c = "Request"',
    );
  });

  it('se nenhuma tentativa for válida, devolve a última com o inválido em discarded', async () => {
    const { llm, send } = await start(bad);
    const res = await send({ ...IDS, ...INPUT });
    expect(res.statusCode).toBe(200);
    expect(llm.requests).toHaveLength(2);
    expect(
      res.json<{ result: { discarded: { name: string }[] } }>().result.discarded,
    ).toMatchObject([{ name: 'SubType__c', value: 'Fees' }]);
  });

  it('422 com dependências em círculo, sem chamar o modelo', async () => {
    const { llm, send } = await start(good);
    const res = await send({
      ...IDS,
      fields: [
        { name: 'A__c', controllingField: 'B__c', options: [{ value: 'X' }] },
        { name: 'B__c', controllingField: 'A__c', options: [{ value: 'Y' }] },
      ],
    });
    expect(res.statusCode).toBe(422);
    const details = res.json<{ error: { details: { path: string }[] } }>().error.details;
    expect(details.map((d) => d.path)).toContain('input.fields.0.controllingField');
    expect(llm.requests).toHaveLength(0);
  });
});
