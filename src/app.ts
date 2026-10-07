import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './http/error-handler.js';
import { healthRoutes, type ReadinessCheck } from './http/routes/health.js';

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

export interface BuildAppOptions {
  config: AppConfig;
  readinessChecks?: ReadinessCheck[];
}

export async function buildApp({
  config,
  readinessChecks = [],
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Nunca registar credenciais. O corpo dos pedidos não é registado.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: config.maxBodyBytes,
    genReqId: () => randomUUID(),
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // As sondas de saúde correm a cada poucos segundos; não as registar.
      disableRequestLogging: (req: { url?: string }) => PROBE_PATHS.has(req.url ?? ''),
    }),
    ajv: {
      customOptions: {
        // Juntar todos os erros de validação numa só resposta 422.
        allErrors: true,
        removeAdditional: false,
        coerceTypes: false,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  registerErrorHandling(app);

  await app.register(healthRoutes, { checks: readinessChecks });

  return app;
}
