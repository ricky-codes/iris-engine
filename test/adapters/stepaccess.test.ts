import { describe, expect, it } from 'vitest';
import { StepAccessClient } from '../../src/adapters/stepaccess-access.js';
import { fakeFetch, json } from '../engine/fakes.js';

const CONFIG = {
  url: 'https://access.example.com',
  user: 'iris',
  password: 'segredo',
  componentUuid: '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
  timeoutMs: 1000,
};
const REQ = { orgId: '00DAAAAAAAAAAAAAAA', userId: '005AAAAAAAAAAAAAAA' };

describe('StepAccessClient', () => {
  it('pergunta pela org, utilizador e componente IRIS, com autenticação Basic', async () => {
    const f = fakeFetch(() => json(200, { hasAccess: true, reason: null }));
    await new StepAccessClient(CONFIG, f.fn).check(REQ);

    const url = new URL(f.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://access.example.com/v1/access');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...REQ,
      componentUuid: CONFIG.componentUuid,
    });
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('iris:segredo').toString('base64')}`,
    );
  });

  it('limite atingido dá 429 quota_exceeded', async () => {
    const f = fakeFetch(() => json(200, { hasAccess: false, reason: 'LIMIT_REACHED' }));
    await expect(new StepAccessClient(CONFIG, f.fn).check(REQ)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
  });

  it.each(['NO_SUBSCRIPTION', 'NOT_MEMBER', 'NOT_GRANTED', 'NOT_INCLUDED', 'UNKNOWN'])(
    '%s dá 403 access_denied, com a razão nos detalhes',
    async (reason) => {
      const f = fakeFetch(() => json(200, { hasAccess: false, reason }));
      await expect(new StepAccessClient(CONFIG, f.fn).check(REQ)).rejects.toMatchObject({
        code: 'access_denied',
        details: [{ path: 'access', issue: reason }],
      });
    },
  );

  it.each([
    ['erro do StepAccess', () => json(500, {})],
    ['credenciais erradas', () => json(401, {})],
    ['limite de pedidos do StepAccess', () => json(429, {})],
    ['corpo que não é JSON', () => new Response('<html>', { status: 200 })],
    ['resposta sem hasAccess', () => json(200, {})],
  ])('falha fechada (503) com %s', async (_label, respond) => {
    const f = fakeFetch(respond);
    await expect(new StepAccessClient(CONFIG, f.fn).check(REQ)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });

  it('falha fechada (503) sem rede ou com tempo esgotado', async () => {
    const f = fakeFetch(() => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    await expect(new StepAccessClient(CONFIG, f.fn).check(REQ)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});
