import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ReadinessCheck } from '../src/http/routes/health.js';
import type { ToolRoutesOptions } from '../src/http/routes/tools.js';

export interface TestAppOptions {
  env?: NodeJS.ProcessEnv;
  readinessChecks?: ReadinessCheck[];
  engine?: ToolRoutesOptions;
  logStream?: NodeJS.WritableStream;
  /** Regista rotas extra antes de a app ficar pronta. */
  setup?: (app: FastifyInstance) => void | Promise<void>;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...opts.env });
  const app = await buildApp({
    config,
    readinessChecks: opts.readinessChecks ?? [],
    ...(opts.engine && { engine: opts.engine }),
    ...(opts.logStream && { logStream: opts.logStream }),
  });
  await opts.setup?.(app);
  await app.ready();
  return app;
}
