import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('responde 200 com X-Request-Id', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /readyz', () => {
  it('responde 200 quando todas as dependências estão acessíveis', async () => {
    app = await buildTestApp({
      readinessChecks: [{ name: 'db', check: async () => {} }],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { db: 'ok' } });
  });

  it('responde 503 quando uma dependência falha', async () => {
    app = await buildTestApp({
      readinessChecks: [
        { name: 'db', check: async () => {} },
        {
          name: 'cache',
          check: async () => {
            throw new Error('down');
          },
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { db: 'ok', cache: 'failed' } });
  });
});
