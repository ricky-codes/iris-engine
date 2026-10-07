import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

/**
 * Verifica se uma dependência externa está acessível.
 * As dependências (base de dados, cache, fornecedor do modelo) registam-se
 * aqui à medida que forem sendo adicionadas.
 */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

const HealthResponse = Type.Object({ status: Type.Literal('ok') });

const ReadyResponse = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  checks: Type.Record(Type.String(), Type.Union([Type.Literal('ok'), Type.Literal('failed')])),
});

export const healthRoutes: FastifyPluginAsyncTypebox<{ checks: ReadinessCheck[] }> = async (
  app,
  opts,
) => {
  app.get('/healthz', { schema: { response: { 200: HealthResponse } } }, async () => ({
    status: 'ok' as const,
  }));

  app.get(
    '/readyz',
    { schema: { response: { 200: ReadyResponse, 503: ReadyResponse } } },
    async (request, reply) => {
      const results = await Promise.all(
        opts.checks.map(async ({ name, check }) => {
          try {
            await check();
            return [name, 'ok'] as const;
          } catch (err) {
            request.log.warn({ err, dependency: name }, 'readiness check failed');
            return [name, 'failed'] as const;
          }
        }),
      );
      const checks = Object.fromEntries(results);
      const ready = results.every(([, s]) => s === 'ok');
      return reply
        .status(ready ? 200 : 503)
        .send({ status: ready ? ('ready' as const) : ('not_ready' as const), checks });
    },
  );
};
