import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ReadinessCheck } from '../src/http/routes/health.js';
import type { AdminRoutesOptions } from '../src/http/routes/admin.js';
import type { MemoryRoutesOptions } from '../src/http/routes/memories.js';
import type { ToolRoutesOptions } from '../src/http/routes/tools.js';
import { DEFAULT_MEMORY_LIMITS } from '../src/engine/memory.js';
import {
  LiveSettings,
  type RuntimeSettings,
  type SettingsStore,
} from '../src/settings/settings.js';

/** Definições com os valores de origem (sem base de dados, salvo `store`). */
export function testSettings(over: Partial<RuntimeSettings> = {}, store?: SettingsStore) {
  return new LiveSettings(
    {
      defaultModel: 'google/gemini-2.5-flash',
      fallbackModels: [],
      totalTimeoutMs: 30_000,
      maxAttempts: 2,
      breakerThreshold: 3,
      breakerOpenMs: 60_000,
      streamEnabled: true,
      rateLimitPerMinute: 0,
      stepAccessTimeoutMs: 3000,
      stepAccessUsageTimeoutMs: 10_000,
      memoryMaxChars: DEFAULT_MEMORY_LIMITS.chars,
      memoryPerOrg: DEFAULT_MEMORY_LIMITS.perOrg,
      memoryPerUser: DEFAULT_MEMORY_LIMITS.perUser,
      ...over,
    },
    store,
  );
}

export interface TestAppOptions {
  env?: NodeJS.ProcessEnv;
  readinessChecks?: ReadinessCheck[];
  engine?: ToolRoutesOptions;
  memories?: MemoryRoutesOptions;
  admin?: AdminRoutesOptions;
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
    ...(opts.memories && { memories: opts.memories }),
    ...(opts.admin && { admin: opts.admin }),
    ...(opts.logStream && { logStream: opts.logStream }),
  });
  await opts.setup?.(app);
  await app.ready();
  return app;
}
