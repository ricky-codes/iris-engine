import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, missingEngineConfig, type AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { BypassAccessChecker } from './adapters/bypass-access.js';
import { checkOpenRouter, checkStepAccess, timed, type CheckResult } from './adapters/health.js';
import { ModelCatalog } from './adapters/openrouter-models.js';
import { OpenRouterProvider } from './adapters/openrouter.js';
import { PgEngineStore, syncToolCatalog } from './adapters/postgres-store.js';
import { StepAccessClient } from './adapters/stepaccess-access.js';
import { StepAccessUsageReporter } from './adapters/stepaccess-usage.js';
import type { AccessChecker } from './engine/access.js';
import { Metrics } from './engine/metrics.js';
import type { ToolDefinition } from './engine/tool.js';
import type { AdminRoutesOptions, StatusReport } from './http/routes/admin.js';
import type { ToolRoutesOptions } from './http/routes/tools.js';
import { enabledTools } from './tools/index.js';

// Os clientes externos registam avisos no logger da app, que só existe depois de criada.
let logger: FastifyBaseLogger | undefined;
const warn = (msg: string, data: Record<string, unknown>): void => {
  logger?.warn(data, msg);
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

function accessChecker(config: AppConfig): AccessChecker | undefined {
  const sa = config.engine.stepAccess;
  if (sa === undefined) return undefined;
  return sa === 'bypass' ? new BypassAccessChecker() : new StepAccessClient(sa, fetch, warn);
}

/** Monta o motor se a configuração estiver completa. Devolve também o que falta, se faltar. */
function buildEngine(
  config: AppConfig,
  pool: pg.Pool | undefined,
  tools: ToolDefinition[],
  metrics: Metrics,
): { engine: ToolRoutesOptions | undefined; missing: string[] } {
  const { engine: cfg } = config;
  const missing = missingEngineConfig(cfg, pool !== undefined);
  const access = accessChecker(config);
  if (
    missing.length > 0 ||
    pool === undefined ||
    cfg.apiSecret === undefined ||
    access === undefined ||
    cfg.openRouter === undefined
  ) {
    return { engine: undefined, missing };
  }
  return {
    missing: [],
    engine: {
      tools,
      apiSecret: cfg.apiSecret,
      metrics,
      deps: {
        access,
        store: new PgEngineStore(pool),
        llm: new OpenRouterProvider(cfg.openRouter, fetch, warn),
        defaultModel: cfg.defaultModel,
        ...(cfg.stepAccess !== undefined &&
          cfg.stepAccess !== 'bypass' && {
            usage: new StepAccessUsageReporter(cfg.stepAccess, fetch, warn),
          }),
      },
    },
  };
}

function buildAdmin(
  config: AppConfig,
  pool: pg.Pool | undefined,
  tools: ToolDefinition[],
  metrics: Metrics,
  engine: { ready: boolean; missing: string[] },
): AdminRoutesOptions | undefined {
  if (config.adminApiSecret === undefined || pool === undefined) return undefined;
  const { engine: cfg } = config;
  const startedAt = new Date();
  const version = readVersion();

  const status = async (): Promise<StatusReport> => {
    const sa = cfg.stepAccess;
    const notConfigured = (detail: string): Promise<CheckResult> =>
      Promise.resolve({ status: 'not_configured', latencyMs: null, detail });
    const [database, stepAccess, openRouter] = await Promise.all([
      timed(async () => {
        await pool.query('SELECT 1');
        return undefined;
      }),
      sa === undefined
        ? notConfigured('STEPACCESS_* em falta')
        : sa === 'bypass'
          ? notConfigured('STEPACCESS_BYPASS ativo: pedidos não verificados')
          : checkStepAccess(sa.url),
      cfg.openRouter === undefined
        ? notConfigured('OPENROUTER_API_KEY em falta')
        : checkOpenRouter(cfg.openRouter),
    ]);
    return {
      service: {
        name: 'iris-engine',
        version,
        environment: config.env,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      },
      engine: { ready: engine.ready, missing: engine.missing, tools: tools.map((t) => t.name) },
      config: {
        stepAccess: sa === undefined ? 'missing' : sa === 'bypass' ? 'bypass' : 'live',
        openRouter: cfg.openRouter === undefined ? 'missing' : 'configured',
        defaultModel: cfg.defaultModel,
        diagnosticTool: cfg.enableDiagnosticTool,
      },
      checks: { database, stepAccess, openRouter },
    };
  };

  return {
    secret: config.adminApiSecret,
    pool,
    tools,
    defaultModel: cfg.defaultModel,
    metrics,
    status,
    models: new ModelCatalog(cfg.openRouter?.baseUrl ?? 'https://openrouter.ai/api/v1'),
    playground:
      cfg.openRouter === undefined
        ? undefined
        : {
            store: new PgEngineStore(pool),
            llm: new OpenRouterProvider(cfg.openRouter, fetch, warn),
            access: accessChecker(config),
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
  const tools = enabledTools({ diagnostic: config.engine.enableDiagnosticTool });
  // O catálogo é atualizado sempre que há base de dados, para a API de admin ver as ferramentas.
  if (pool !== undefined) {
    await syncToolCatalog(
      pool,
      tools.map((t) => t.name),
    );
  }

  const metrics = new Metrics();
  const { engine, missing } = buildEngine(config, pool, tools, metrics);
  const admin = buildAdmin(config, pool, tools, metrics, { ready: engine !== undefined, missing });

  const app = await buildApp({
    config,
    ...(engine && { engine }),
    ...(admin && { admin }),
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
  app.log.info(
    admin === undefined
      ? 'API de administração desligada (falta ADMIN_API_SECRET ou DATABASE_URL)'
      : 'API de administração ligada em /v1/admin',
  );

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
