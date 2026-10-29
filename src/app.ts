import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './http/error-handler.js';
import { healthRoutes, type ReadinessCheck } from './http/routes/health.js';
import { adminRoutes, type AdminRoutesOptions } from './http/routes/admin.js';
import { compatRoutes } from './http/routes/compat.js';
import { memoryRoutes, type MemoryRoutesOptions } from './http/routes/memories.js';
import { toolRoutes, type ToolRoutesOptions } from './http/routes/tools.js';

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

export interface BuildAppOptions {
  config: AppConfig;
  readinessChecks?: ReadinessCheck[];
  /** Sem motor não há rotas de ferramentas (`/v1/*`). */
  engine?: ToolRoutesOptions;
  /** Sem opções não há rotas de memórias (`/v1/memories`). */
  memories?: MemoryRoutesOptions;
  /** Sem opções não há API de administração (`/v1/admin/*`). */
  admin?: AdminRoutesOptions;
  /** Destino dos logs; só os testes o definem. */
  logStream?: NodeJS.WritableStream;
}

export async function buildApp({
  config,
  readinessChecks = [],
  engine,
  memories,
  admin,
  logStream,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Nunca registar credenciais. O corpo dos pedidos não é registado.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(logStream && { stream: logStream }),
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
  if (engine !== undefined) {
    await app.register(toolRoutes, engine);
    await app.register(compatRoutes, engine);
  }
  if (memories !== undefined) await app.register(memoryRoutes, memories);
  if (admin !== undefined) await app.register(adminRoutes, admin);

  return app;
}
