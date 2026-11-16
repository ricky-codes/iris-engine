import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ToolDefinition } from '../../src/engine/tool.js';
import { replyTool } from '../../src/tools/reply.js';
import {
  buildReplyMessage,
  cleanEmailBody,
  contextFields,
  conversation,
  placeholdersIn,
  removeClosing,
  relevantRelated,
  removeGreeting,
  replySubject,
  stripMarkdown,
  toneText,
  type ReplyInputView,
} from '../../src/tools/reply-text.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeStore } from '../engine/fakes.js';
import { buildTestApp } from '../helpers.js';

/** O pedido real da execução #3368 do n8n, anonimizado. */
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'reply-3368.json'), 'utf8'),
) as ReplyInputView & Record<string, unknown>;

const finalize = (reply: string, input: ReplyInputView = FIXTURE, missingInfo: string[] = []) =>
  replyTool.finalize?.({ reply, missingInfo }, input as never, { suggestThreshold: 0.6 });

describe('reply: a mensagem para o modelo', () => {
  const msg = buildReplyMessage(FIXTURE);

  it('começa pela mensagem do cliente, com o assunto e a data', () => {
    expect(msg.split('\n').slice(0, 3)).toEqual([
      'MENSAGEM DO CLIENTE A QUE RESPONDES (19/07/2026):',
      'Assunto: RE: Movimento não reconhecido — possível fraude',
      'Bom dia,',
    ]);
  });

  it('é muito mais pequena que o JSON e não leva ids, contactos nem lixo técnico', () => {
    expect(msg.length).toBeLessThan(JSON.stringify(FIXTURE).length / 3);
    for (const absent of [
      '02sgL',
      '500gL',
      '003gL',
      '@',
      '757',
      'thread::',
      'Austin',
      'generator',
      'MB WAY',
      'Agente Exemplo',
      '"status"',
    ])
      expect(msg, absent).not.toContain(absent);
  });

  it('o que interessa: formato, tom, tipificação, cliente e o que já foi respondido', () => {
    expect(msg).toContain('FORMATO: NÃO escrever saudação');
    expect(msg).toContain('NÃO escrever despedida nem assinatura');
    expect(msg).toContain('TOM: tom equilibrado · empático · formalidade média');
    expect(msg).toContain(
      'Tipificação: Pedido › Transferência SEPA › Operação não reconhecida › Pedido de bloqueio',
    );
    expect(msg).toContain('Cliente: Rose Gonzalez (Edge Communications)');
    expect(msg).toContain(
      'JÁ RESPONDIDO PELA EQUIPA A ESTA MENSAGEM: 6 vez(es), a última em 25/10/2026.',
    );
    // As seis respostas seguidas da equipa ficam numa só, sem saudação nem despedida.
    const team = msg.split('\n').filter((l) => l.startsWith('[equipa'));
    expect(team).toHaveLength(1);
    expect(team[0]).toMatch(/^\[equipa, 25\/10\/2026, mais recente de 6 seguidas\] Compreendemos/);
    expect(msg).toContain('NOTAS DA EQUIPA (contexto; não citar nem revelar ao cliente):');
  });

  it('sem saudação da empresa, pede-a ao modelo com o nome do cliente', () => {
    const m = buildReplyMessage({
      ...FIXTURE,
      payload: {
        ...FIXTURE.payload,
        replySettings: { hasGreeting: false, houseRules: ['Tratar por você.'] },
      },
    });
    expect(m).toContain('escrever uma saudação adequada ao tom, ao cliente Rose Gonzalez.');
    expect(m).toContain('Escrever uma despedida curta');
    expect(m).toContain('REGRAS DA EMPRESA (obrigatórias):\n- Tratar por você.');
  });

  it('campos extra do administrador como "rótulo: valor", sem os vazios', () => {
    expect(
      contextFields([
        { field: 'Segment__c', label: 'Segmento', value: 'Premium' },
        { field: 'X__c', label: 'Vazio', value: '' },
        { field: 'N__c', label: 'Número', value: 3 },
      ]),
    ).toEqual(['Segmento: Premium', 'Número: 3']);
  });
});

describe('reply: Cases relacionados (reincidência)', () => {
  const current = {
    id: '500CURRENT',
    subject: 'Movimento não reconhecido — possível fraude',
    typification: ['Pedido', 'Transferência SEPA', 'Operação não reconhecida'],
    createdDate: '2026-07-19T14:35:13.000Z',
  };
  const ref = new Date('2026-07-19T14:35:13.000Z').getTime();
  const rel = (over: Record<string, unknown>) => ({
    id: `500${String(Math.random()).slice(2, 8)}`,
    caseNumber: '00009999',
    status: 'Closed',
    subject: 'Outro assunto',
    createdDate: '2026-07-01T10:00:00.000Z',
    ...over,
  });

  it('entram só os do mesmo tipo e subtipo, recentes, no máximo 3, sem números', () => {
    const same = { typification: ['Pedido', 'Transferência SEPA', 'Outra classificação'] };
    const out = relevantRelated(
      [
        rel({ ...same, subject: 'Transferência estranha', createdDate: '2026-07-10T00:00:00Z' }),
        rel({ ...same, createdDate: '2026-06-01T00:00:00Z' }),
        rel({ ...same, createdDate: '2026-05-01T00:00:00Z' }),
        rel({ ...same, createdDate: '2026-04-30T00:00:00Z' }),
        // Mais de 90 dias antes.
        rel({ ...same, createdDate: '2026-01-01T00:00:00Z' }),
        // Outra tipificação, mesmo com um assunto parecido.
        rel({ typification: ['Pedido', 'Cartão'], subject: 'Movimento não reconhecido' }),
        // O próprio Case.
        { ...current },
      ],
      current,
      ref,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      date: '10/07/2026',
      status: 'Closed',
      subject: 'Transferência estranha',
      typification: 'Pedido › Transferência SEPA › Outra classificação',
    });
    expect(JSON.stringify(out)).not.toContain('00009999');
  });

  it('só o tipo não chega; sem tipificação, compara o assunto', () => {
    expect(relevantRelated([rel({ typification: ['Pedido'] })], current, ref)).toHaveLength(0);
    expect(
      relevantRelated(
        [
          rel({ subject: 'Novo movimento não reconhecido na conta' }),
          rel({ subject: 'Starting generator after electrical failure' }),
        ],
        current,
        ref,
      ).map((r) => r.subject),
    ).toEqual(['Novo movimento não reconhecido na conta']);
  });

  it('na mensagem: uma secção própria, com a instrução de não citar', () => {
    const msg = buildReplyMessage({
      ...FIXTURE,
      relatedCases: [
        rel({
          typification: ['Pedido', 'Transferência SEPA'],
          subject: 'Débito desconhecido',
          createdDate: '2026-07-05T00:00:00Z',
        }),
      ],
    });
    expect(msg).toContain(
      'CASES ANTERIORES DO CLIENTE SOBRE O MESMO TEMA (só para reconhecer a reincidência; não cites números nem detalhes desses Cases):\n[05/07/2026, Closed] Débito desconhecido · Pedido › Transferência SEPA',
    );
    // No #3368 nenhum é do mesmo tema: a secção não aparece.
    expect(buildReplyMessage(FIXTURE)).not.toContain('CASES ANTERIORES');
  });
});

describe('reply: emails e conversa', () => {
  it('corta o histórico citado, as referências de thread e a assinatura, e mascara emails', () => {
    const body = [
      'Olá, ainda não recebi a encomenda. Escrevam para joao@exemplo.pt.',
      '',
      '--',
      'João',
      'Em 10/11/2026, apoio@empresa.pt escreveu:',
      '> mensagem antiga',
    ].join('\n');
    expect(cleanEmailBody(body)).toBe('Olá, ainda não recebi a encomenda. Escrevam para [email].');
    expect(cleanEmailBody('Texto\nthread::abc123::\nOn Mon, 1 Jan 2026, X wrote:\n> antigo')).toBe(
      'Texto',
    );
  });

  it('tira o email selecionado e só junta respostas da equipa seguidas', () => {
    const history = conversation(
      [
        { id: 'sel', incoming: true, messageDate: '2026-01-01T10:00:00Z', textBody: 'A pergunta' },
        { id: 'a', incoming: false, messageDate: '2026-01-02T10:00:00Z', textBody: 'Resposta 1' },
        { id: 'b', incoming: true, messageDate: '2026-01-03T10:00:00Z', textBody: 'Insisto' },
        { id: 'c', incoming: false, messageDate: '2026-01-04T10:00:00Z', textBody: 'Resposta 2' },
        { id: 'd', incoming: false, messageDate: '2026-01-05T10:00:00Z', textBody: 'Resposta 3' },
      ],
      { id: 'sel', body: 'A pergunta' },
    );
    expect(history.map((e) => [e.incoming, e.text, e.repeats])).toEqual([
      [false, 'Resposta 3', 1],
      [true, 'Insisto', 0],
      [false, 'Resposta 1', 0],
    ]);
  });

  it('o tom de 0 a 100 em palavras', () => {
    expect(toneText({ tone: 10, empathy: 50, formality: 90 })).toBe(
      'tom neutro · simpatia moderada · formal',
    );
    expect(toneText(null)).toBe('profissional e cordial');
  });
});

describe('reply: a resposta', () => {
  it('#3368: tira a saudação e a despedida que o modelo escreveu apesar das regras', () => {
    const out = finalize(
      'Cara Rose,\n\nCompreendemos a sua **preocupação**.\n\nO pedido está em análise.\n\nCom os melhores cumprimentos,\nEquipa',
      FIXTURE,
      ['Resultado da análise de fraude'],
    );
    expect(out).toEqual({
      reply: 'Compreendemos a sua preocupação.\n\nO pedido está em análise.',
      subject: 'RE: Movimento não reconhecido — possível fraude',
      recommendedTone: 'tom equilibrado · empático · formalidade média',
      missingInfo: ['Resultado da análise de fraude'],
      placeholders: [],
    });
  });

  it('sem regras da empresa, deixa a saudação e a despedida do modelo', () => {
    const input = { ...FIXTURE, payload: { ...FIXTURE.payload, replySettings: {} } };
    const text = 'Cara Rose,\n\nTexto.\n\nCom os melhores cumprimentos,\nA equipa';
    expect(finalize(text, input)?.['reply']).toBe(text);
  });

  it('saudação na mesma linha do texto', () => {
    expect(removeGreeting('Cara Rose, compreendemos a sua preocupação.\n\nMais.')).toBe(
      'Compreendemos a sua preocupação.\n\nMais.',
    );
    expect(removeGreeting('Bom dia,\nTexto')).toBe('Texto');
    expect(removeGreeting('Compreendemos, claro.')).toBe('Compreendemos, claro.');
  });

  it('só tira a despedida no fim, não um agradecimento a meio', () => {
    expect(removeClosing('Texto.\n\nAtenciosamente,\nAna Silva\nApoio')).toBe('Texto.');
    const long = 'Texto.\n\nObrigado pela paciência enquanto analisamos o seu pedido com cuidado.';
    expect(removeClosing(long)).toBe(long);
  });

  it('tira o markdown e encontra os marcadores a preencher', () => {
    const text = stripMarkdown('```json\n## Título\n**Nova** data: [DATA]\n* ponto\n```');
    expect(text).toBe('Título\nNova data: [DATA]\n- ponto');
    expect(placeholdersIn('Em [DATA], valor [VALOR] e [email].')).toEqual(['[DATA]', '[VALOR]']);
  });

  it('o assunto: RE: sem repetir prefixos', () => {
    expect(replySubject('RE: Re: FW: Encomenda')).toBe('RE: Encomenda');
    expect(replySubject('Encomenda')).toBe('RE: Encomenda');
    expect(replySubject(undefined)).toBe('RE:');
  });
});

describe('POST /v1/tools/reply', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const SECRET = 's'.repeat(40);

  it('responde com o texto limpo, o assunto, o tom e o que falta', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        reply: 'Cara Rose,\n\nO seu pedido continua em análise.',
        missingInfo: ['Resultado da análise de fraude'],
      }),
    );
    app = await buildTestApp({
      engine: {
        apiSecret: SECRET,
        engine: fakeEngine([replyTool as unknown as ToolDefinition], {
          access: fakeAccess().access,
          llm: llm.llm,
          ...fakeStore(),
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/reply',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { ...FIXTURE, orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tool: 'reply',
      version: 2,
      result: {
        reply: 'O seu pedido continua em análise.',
        subject: 'RE: Movimento não reconhecido — possível fraude',
        recommendedTone: 'tom equilibrado · empático · formalidade média',
        missingInfo: ['Resultado da análise de fraude'],
        placeholders: [],
      },
    });
    // O modelo recebeu a mensagem montada, não o JSON.
    expect(llm.requests[0]?.user).toMatch(/^MENSAGEM DO CLIENTE A QUE RESPONDES/);
  });

  it('422 com os eixos do tom em português (os campos são em inglês)', async () => {
    app = await buildTestApp({
      engine: {
        apiSecret: SECRET,
        engine: fakeEngine([replyTool as unknown as ToolDefinition], {
          access: fakeAccess().access,
          llm: fakeLlm('{}').llm,
          ...fakeStore(),
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/reply',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: {
        ...FIXTURE,
        orgId: '00DAAAAAAAAAAAAAAA',
        userId: '005AAAAAAAAAAAAAAA',
        payload: { ...FIXTURE.payload, toneParams: { tom: 50 } },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('422 sem o email selecionado', async () => {
    app = await buildTestApp({
      engine: {
        apiSecret: SECRET,
        engine: fakeEngine([replyTool as unknown as ToolDefinition], {
          access: fakeAccess().access,
          llm: fakeLlm('{}').llm,
          ...fakeStore(),
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/reply',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA', payload: {} },
    });
    expect(res.statusCode).toBe(422);
  });
});
