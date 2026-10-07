import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AppError, type ErrorBody } from '../src/http/errors.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** App de teste com rotas que exercitam cada caminho de erro. */
function appWithProbeRoutes(env: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  return buildTestApp({
    env,
    setup: (instance) => {
      const typed = instance.withTypeProvider<TypeBoxTypeProvider>();
      typed.post(
        '/probe/validate',
        {
          schema: {
            body: Type.Object({ name: Type.String(), age: Type.Integer({ minimum: 0 }) }),
          },
        },
        async () => ({ ok: true }),
      );
      typed.get('/probe/domain', async () => {
        throw new AppError('not_implemented', 501, 'Ainda não implementado.');
      });
      typed.get('/probe/crash', async () => {
        throw new Error('segredo interno');
      });
    },
  });
}

describe('formato de erro', () => {
  it('404 para rotas inexistentes', async () => {
    app = await appWithProbeRoutes();
    const res = await app.inject({ method: 'GET', url: '/nada' });
    expect(res.statusCode).toBe(404);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('422 com a lista de todos os campos inválidos', async () => {
    app = await appWithProbeRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      payload: { age: -1 },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details.length).toBeGreaterThanOrEqual(2);
  });

  it('400 para JSON mal formado', async () => {
    app = await appWithProbeRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('invalid_request');
  });

  it('413 quando o corpo excede o limite', async () => {
    app = await appWithProbeRoutes({ MAX_BODY_BYTES: '1024' });
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      payload: { name: 'x'.repeat(2000), age: 1 },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<ErrorBody>().error.code).toBe('payload_too_large');
  });

  it('erros de domínio mantêm código e estado', async () => {
    app = await appWithProbeRoutes();
    const res = await app.inject({ method: 'GET', url: '/probe/domain' });
    expect(res.statusCode).toBe(501);
    expect(res.json<ErrorBody>().error.code).toBe('not_implemented');
  });

  it('500 sem expor detalhes internos', async () => {
    app = await appWithProbeRoutes();
    const res = await app.inject({ method: 'GET', url: '/probe/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json<ErrorBody>().error.code).toBe('internal_error');
    expect(res.body).not.toContain('segredo interno');
  });
});
