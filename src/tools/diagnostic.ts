import { Type } from '@sinclair/typebox';
import { defineTool } from '../engine/tool.js';

/**
 * Ferramenta de diagnóstico: prova o caminho completo (chave, StepAccess, memórias,
 * modelo, validação) sem depender do Salesforce. Só existe com ENABLE_DIAGNOSTIC_TOOL=true.
 */
export const diagnosticTool = defineTool({
  name: 'diagnostic',
  version: 1,
  description: 'Teste de ligação: responde em uma ou duas frases à mensagem enviada.',
  input: Type.Object({
    message: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
  output: Type.Object(
    {
      reply: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  systemPrompt: [
    'És a IRIS, a assistente de IA da Step Ahead para equipas de apoio ao cliente no Salesforce.',
    'Isto é um teste de ligação. Responde à mensagem do utilizador em português de Portugal,',
    'em uma ou duas frases, respeitando as memórias indicadas abaixo, se existirem.',
    'Devolve apenas JSON no formato {"reply": "<resposta>"}.',
  ].join('\n'),
  defaults: { temperature: 0.2, maxOutputTokens: 300, timeoutMs: 20_000 },
  buildUserMessage: (input) => input.message,
});
