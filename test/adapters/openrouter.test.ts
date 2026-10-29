import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../../src/adapters/openrouter.js';
import type { LlmRequest } from '../../src/engine/llm.js';
import { fakeFetch, json } from '../engine/fakes.js';

const CONFIG = { apiKey: 'sk-or-teste', baseUrl: 'https://openrouter.ai/api/v1' };
const REQ: LlmRequest = {
  model: 'google/gemini-2.5-flash',
  system: 'sistema',
  user: 'utilizador',
  temperature: 0.2,
  maxOutputTokens: 300,
  timeoutMs: 1000,
  output: {
    name: 'diagnostic_result',
    schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] },
  },
};

const completion = (content: string) =>
  json(200, {
    model: 'google/gemini-2.5-flash',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 42, completion_tokens: 7, cost: 0.00042 },
  });

describe('OpenRouterProvider', () => {
  it('pede JSON com o esquema da ferramenta e só a fornecedores que não guardam dados', async () => {
    const f = fakeFetch(() => completion('{"reply":"olá"}'));
    const res = await new OpenRouterProvider(CONFIG, f.fn).complete(REQ);

    expect(res).toEqual({
      text: '{"reply":"olá"}',
      model: 'google/gemini-2.5-flash',
      inputTokens: 42,
      outputTokens: 7,
      costUsd: 0.00042,
    });
    expect(f.calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-teste');
    const body = JSON.parse(f.calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'sistema' },
        { role: 'user', content: 'utilizador' },
      ],
      temperature: 0.2,
      max_tokens: 300,
      usage: { include: true },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'diagnostic_result', strict: true, schema: REQ.output.schema },
      },
      provider: { data_collection: 'deny', require_parameters: true },
    });
  });

  it.each([
    ['chave inválida', () => json(401, { error: { code: 401, message: 'No auth' } })],
    ['sem créditos', () => json(402, { error: { code: 402, message: 'Insufficient credits' } })],
    ['limite do fornecedor', () => json(429, { error: { code: 429, message: 'Rate limited' } })],
    ['erro dentro de um 200', () => json(200, { error: { code: 502, message: 'Upstream' } })],
    ['resposta sem conteúdo', () => json(200, { choices: [] })],
    ['corpo que não é JSON', () => new Response('<html>', { status: 502 })],
  ])('%s dá 502 provider_unavailable', async (_label, respond) => {
    const f = fakeFetch(respond);
    await expect(new OpenRouterProvider(CONFIG, f.fn).complete(REQ)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('tempo esgotado dá 504 timeout', async () => {
    const f = fakeFetch(() => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await expect(new OpenRouterProvider(CONFIG, f.fn).complete(REQ)).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
