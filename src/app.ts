import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createAuthenticator } from './auth/authenticate.js';
import type { CredentialStore } from './auth/credential-store.js';
import type { AppConfig } from './config.js';
import { registerErrorHandling } from './http/error-handler.js';
import { healthRoutes, type ReadinessCheck } from './http/routes/health.js';
import { whoamiRoutes } from './http/routes/whoami.js';

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

export interface BuildAppOptions {
  config: AppConfig;
  readinessChecks?: ReadinessCheck[];
  /** Sem credenciais não há rotas autenticadas (`/v1/*`). */
  credentialStore?: CredentialStore;
  /** Relógio injetável, para testar expiração de chaves. */
  clock?: () => Date;
  /** Destino dos logs; só os testes o definem. */
  logStream?: NodeJS.WritableStream;
}

export async function buildApp({
  config,
  readinessChecks = [],
  credentialStore,
  clock,
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

  app.decorateRequest('auth', undefined);

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  registerErrorHandling(app);

  await app.register(healthRoutes, { checks: readinessChecks });

  if (credentialStore !== undefined) {
    const authenticate = createAuthenticator(credentialStore, clock);
    await app.register(whoamiRoutes, { authenticate });
  }

  return app;
}
