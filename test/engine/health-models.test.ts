import { describe, expect, it } from 'vitest';
import { checkOpenRouter, checkStepAccess } from '../../src/engine/health.js';
import { ModelCatalog } from '../../src/engine/models.js';
import { fakeFetch, json } from './fakes.js';

describe('verificações de dependências', () => {
  it('StepAccess: usa /v1/health, sem credenciais e sem contar utilização', async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    expect(await checkStepAccess('https://access.example.com', f.fn)).toMatchObject({
      status: 'ok',
    });
    expect(f.calls[0]?.url).toBe('https://access.example.com/v1/health');

    const down = fakeFetch(() => json(503, {}));
    expect(await checkStepAccess('https://x', down.fn)).toMatchObject({
      status: 'failed',
      detail: 'HTTP 503',
    });
  });

  it('OpenRouter: valida a chave e devolve o consumo', async () => {
    const f = fakeFetch(() => json(200, { data: { usage: 1.25, limit: 10 } }));
    const res = await checkOpenRouter(
      { apiKey: 'sk-or', baseUrl: 'https://openrouter.ai/api/v1' },
      f.fn,
    );
    expect(res).toMatchObject({ status: 'ok', credits: { usage: 1.25, limit: 10 } });
    expect(f.calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');

    const bad = fakeFetch(() => json(401, {}));
    expect(await checkOpenRouter({ apiKey: 'x', baseUrl: 'https://o' }, bad.fn)).toMatchObject({
      status: 'failed',
      detail: 'HTTP 401',
    });
  });

  it('falha de rede conta como falha, não rebenta', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await checkStepAccess('https://x', f.fn)).toMatchObject({
      status: 'failed',
      detail: 'TypeError',
    });
  });
});

describe('ModelCatalog', () => {
  const raw = {
    data: [
      {
        id: 'z/model',
        name: 'Z',
        context_length: 1000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['temperature'],
      },
      {
        id: 'a/model',
        name: 'A',
        context_length: 2000,
        pricing: { prompt: '0.0000003', completion: '0.0000025' },
        supported_parameters: ['structured_outputs', 'response_format'],
      },
    ],
  };

  it('normaliza preços por milhão de tokens e indica quem suporta JSON Schema', async () => {
    const f = fakeFetch(() => json(200, raw));
    const { models } = await new ModelCatalog('https://openrouter.ai/api/v1', f.fn).list();
    expect(models).toEqual([
      {
        id: 'a/model',
        name: 'A',
        contextLength: 2000,
        promptPricePerMillion: 0.3,
        completionPricePerMillion: 2.5,
        supportsStructuredOutput: true,
      },
      {
        id: 'z/model',
        name: 'Z',
        contextLength: 1000,
        promptPricePerMillion: 1,
        completionPricePerMillion: 2,
        supportsStructuredOutput: false,
      },
    ]);
  });

  it('guarda a lista em cache durante 15 minutos', async () => {
    let now = 0;
    const f = fakeFetch(() => json(200, raw));
    const catalog = new ModelCatalog('https://o', f.fn, () => now);
    await catalog.list();
    now = 14 * 60_000;
    await catalog.list();
    expect(f.calls).toHaveLength(1);
    now = 16 * 60_000;
    await catalog.list();
    expect(f.calls).toHaveLength(2);
  });

  it('OpenRouter em baixo dá 502 provider_unavailable', async () => {
    const f = fakeFetch(() => json(500, {}));
    await expect(new ModelCatalog('https://o', f.fn).list()).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});
