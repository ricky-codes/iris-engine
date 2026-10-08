import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { CredentialStore } from '../src/auth/credential-store.js';
import type { ReadinessCheck } from '../src/http/routes/health.js';

export interface TestAppOptions {
  env?: NodeJS.ProcessEnv;
  readinessChecks?: ReadinessCheck[];
  credentialStore?: CredentialStore;
  clock?: () => Date;
  logStream?: NodeJS.WritableStream;
  /** Regista rotas extra antes de a app ficar pronta. */
  setup?: (app: FastifyInstance) => void | Promise<void>;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...opts.env });
  const app = await buildApp({
    config,
    readinessChecks: opts.readinessChecks ?? [],
    ...(opts.credentialStore && { credentialStore: opts.credentialStore }),
    ...(opts.clock && { clock: opts.clock }),
    ...(opts.logStream && { logStream: opts.logStream }),
  });
  await opts.setup?.(app);
  await app.ready();
  return app;
}
