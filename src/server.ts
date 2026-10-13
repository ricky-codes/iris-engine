import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, missingEngineConfig, type AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { BypassAccessChecker, StepAccessClient } from './engine/access.js';
import { OpenRouterProvider } from './engine/openrouter.js';
import { PgEngineStore, syncToolCatalog } from './engine/store.js';
import type { ToolRoutesOptions } from './http/routes/tools.js';
import { enabledTools } from './tools/index.js';
import type pg from 'pg';

// Os clientes externos registam avisos no logger da app, que só existe depois de criada.
let logger: FastifyBaseLogger | undefined;
const warn = (msg: string, data: Record<string, unknown>): void => {
  logger?.warn(data, msg);
};

/** Monta o motor se a configuração estiver completa. Devolve também o que falta, se faltar. */
async function buildEngine(
  config: AppConfig,
  pool: pg.Pool | undefined,
): Promise<{ engine: ToolRoutesOptions | undefined; missing: string[] }> {
  const { engine: cfg } = config;
  const missing = missingEngineConfig(cfg, pool !== undefined);
  if (
    missing.length > 0 ||
    pool === undefined ||
    cfg.apiSecret === undefined ||
    cfg.stepAccess === undefined ||
    cfg.openRouter === undefined
  ) {
    return { engine: undefined, missing };
  }

  const tools = enabledTools({ diagnostic: cfg.enableDiagnosticTool });
  await syncToolCatalog(
    pool,
    tools.map((t) => t.name),
  );
  return {
    missing: [],
    engine: {
      tools,
      apiSecret: cfg.apiSecret,
      deps: {
        access:
          cfg.stepAccess === 'bypass'
            ? new BypassAccessChecker()
            : new StepAccessClient(cfg.stepAccess, fetch, warn),
        store: new PgEngineStore(pool),
        llm: new OpenRouterProvider(cfg.openRouter, fetch, warn),
        defaultModel: cfg.defaultModel,
      },
    },
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const pool = config.databaseUrl === undefined ? undefined : createPool(config.databaseUrl);

  const { engine, missing } = await buildEngine(config, pool);

  const app = await buildApp({
    config,
    ...(engine && { engine }),
    readinessChecks:
      pool === undefined
        ? []
        : [
            {
              name: 'database',
              check: async () => {
                await pool.query('SELECT 1');
              },
            },
          ],
  });
  if (pool !== undefined) app.addHook('onClose', async () => pool.end());
  logger = app.log;
  if (engine === undefined) {
    app.log.warn({ missing }, 'motor desligado: falta configuração; só /healthz e /readyz');
  } else {
    if (config.engine.stepAccess === 'bypass') {
      app.log.warn('STEPACCESS_BYPASS ativo: os pedidos não são verificados no StepAccess');
    }
    app.log.info({ tools: engine.tools.map((t) => t.name) }, 'motor pronto');
  }

  // Encerramento ordenado: deixa de aceitar pedidos e termina os que estão em curso.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
