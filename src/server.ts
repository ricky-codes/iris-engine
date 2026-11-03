import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, missingEngineConfig, type AppConfig } from './config.js';
import { createPool } from './db/pool.js';
import { OpenAccessChecker } from './adapters/open-access.js';
import { checkOpenRouter, checkStepAccess, timed, type CheckResult } from './adapters/health.js';
import { ModelCatalog } from './adapters/openrouter-models.js';
import { OpenRouterProvider } from './adapters/openrouter.js';
import { PgMemoryStore } from './adapters/postgres-memory-store.js';
import { PgEngineStore, syncToolCatalog } from './adapters/postgres-store.js';
import { StepAccessClient } from './adapters/stepaccess-access.js';
import { StepAccessUsageReporter } from './adapters/stepaccess-usage.js';
import type { AccessChecker } from './engine/access.js';
import { describeModules } from './admin/modules.js';
import { statusReport } from './admin/status.js';
import { collectTopology } from './admin/topology-source.js';
import type { RuntimeFacts, Topology } from './admin/topology.js';
import { AlertMonitor } from './alerts/monitor.js';
import { PgLeaderLock } from './adapters/pg-leader-lock.js';
import { NoopAlertSink, WebhookAlertSink } from './adapters/webhook-alert-sink.js';
import { createEngine, type Engine } from './engine/engine.js';
import { DEFAULT_MAX_ATTEMPTS } from './engine/run.js';
import { EngineError } from './engine/errors.js';
import {
  MAX_MEMORY_CHARS,
  MAX_ORG_MEMORIES,
  MAX_USER_MEMORIES,
  Memories,
} from './engine/memory.js';
import { Metrics } from './engine/metrics.js';
import type { ToolDefinition } from './engine/tool.js';
import type { AdminRoutesOptions, StatusReport } from './http/routes/admin.js';
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
  return sa === 'open' || sa === 'bypass'
    ? new OpenAccessChecker()
    : new StepAccessClient(sa, fetch, warn);
}

/** Sem StepAccess configurado: recusa tudo o que precise de verificar acesso. */
const noAccess: AccessChecker = {
  check: async () => {
    throw new EngineError('service_unavailable', 'O serviço de licenças não está configurado.');
  },
};

/**
 * Monta o motor, se houver base de dados e OpenRouter. Sem StepAccess o motor existe
 * (para o playground), mas recusa verificar acesso e as rotas públicas ficam desligadas.
 */
function buildEngine(
  config: AppConfig,
  pool: pg.Pool | undefined,
  tools: ToolDefinition[],
  access: AccessChecker | undefined,
  metrics: Metrics,
): Engine | undefined {
  const { engine: cfg } = config;
  if (pool === undefined || cfg.openRouter === undefined) return undefined;
  return createEngine({
    settings: {
      defaultModel: cfg.defaultModel,
      fallbackModels: cfg.fallbackModels,
      totalTimeoutMs: cfg.totalTimeoutMs,
    },
    tools,
    access: access ?? noAccess,
    store: new PgEngineStore(pool),
    memories: new PgMemoryStore(pool),
    llm: new OpenRouterProvider(cfg.openRouter, fetch, warn),
    // Cada chamada a um modelo entra nas métricas por modelo (só nome, resultado e tempo).
    onEvent: (e) => {
      if (e.type === 'model_call') {
        metrics.recordModelCall({
          model: e.model,
          ok: e.reason === 'ok',
          durationMs: e.durationMs,
        });
      }
    },
    ...(cfg.stepAccess !== undefined &&
      typeof cfg.stepAccess === 'object' && {
        usage: new StepAccessUsageReporter(cfg.stepAccess, fetch, warn),
      }),
  });
}

/** O que só o servidor sabe: configuração em vigor, rotas ligadas e verificações das dependências. */
function runtimeFacts(
  config: AppConfig,
  pool: pg.Pool | undefined,
  engine: { ready: boolean; missing: string[] },
  core: Engine | undefined,
  memoriesOn: boolean,
): () => Promise<RuntimeFacts> {
  const { engine: cfg } = config;
  const startedAt = new Date();
  const version = readVersion();
  return async () => {
    const sa = cfg.stepAccess;
    const notConfigured = (detail: string): Promise<CheckResult> =>
      Promise.resolve({ status: 'not_configured', latencyMs: null, detail });
    const [database, stepAccess, openRouter] = await Promise.all([
      pool === undefined
        ? notConfigured('DATABASE_URL em falta')
        : timed(async () => {
            await pool.query('SELECT 1');
            return undefined;
          }),
      sa === undefined
        ? notConfigured('STEPACCESS_* em falta')
        : sa === 'open'
          ? notConfigured('ACCESS_MODE=open: acesso só pelo API_SECRET, sem StepAccess')
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
      engine: {
        ready: engine.ready,
        missing: engine.missing,
        defaultModel: cfg.defaultModel,
        maxAttempts: core?.settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      },
      access: sa === undefined ? 'missing' : typeof sa === 'string' ? sa : 'live',
      openRouter: cfg.openRouter === undefined ? 'missing' : 'configured',
      routes: { tools: engine.ready, memories: memoriesOn },
      checks: { database, stepAccess, openRouter },
    };
  };
}

function buildAdmin(
  config: AppConfig,
  pool: pg.Pool | undefined,
  tools: ToolDefinition[],
  metrics: Metrics,
  runtime: () => Promise<RuntimeFacts>,
  topology: () => Promise<Topology>,
  monitor: AlertMonitor,
  playground: Engine | undefined,
  countsUsage: boolean,
): AdminRoutesOptions | undefined {
  if (config.adminApiSecret === undefined || pool === undefined) return undefined;
  const { engine: cfg } = config;

  const status = async (): Promise<StatusReport> =>
    statusReport({
      runtime: await runtime(),
      tools: tools.map((t) => t.name),
      defaultModel: cfg.defaultModel,
      diagnosticTool: cfg.enableDiagnosticTool,
      alerts: monitor.facts(),
    });

  return {
    secret: config.adminApiSecret,
    pool,
    tools,
    defaultModel: cfg.defaultModel,
    defaultFallbackModels: cfg.fallbackModels,
    metrics,
    status,
    topology,
    modules: async () => {
      const t = await topology();
      const sa = cfg.stepAccess;
      const mem = t.nodes.find((n) => n.id === 'core.memories')?.details;
      return describeModules({
        topology: t,
        engine: {
          defaultModel: cfg.defaultModel,
          fallbackModels: cfg.fallbackModels,
          maxAttempts: playground?.settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          totalTimeoutMs: cfg.totalTimeoutMs,
        },
        access: sa === undefined ? 'missing' : typeof sa === 'string' ? sa : 'live',
        stepAccess:
          typeof sa === 'object'
            ? {
                origin: new URL(sa.url).origin,
                timeoutMs: sa.timeoutMs,
                componentUuid: sa.componentUuid,
              }
            : { origin: null, timeoutMs: null, componentUuid: null },
        openRouter: {
          baseUrl: cfg.openRouter?.baseUrl ?? null,
          configured: cfg.openRouter !== undefined,
        },
        memories: {
          chars: MAX_MEMORY_CHARS,
          perOrg: MAX_ORG_MEMORIES,
          perUser: MAX_USER_MEMORIES,
          org: typeof mem?.['org'] === 'number' ? mem['org'] : 0,
          user: typeof mem?.['user'] === 'number' ? mem['user'] : 0,
        },
      });
    },
    alerts: monitor,
    models: new ModelCatalog(cfg.openRouter?.baseUrl ?? 'https://openrouter.ai/api/v1'),
    playground: playground === undefined ? undefined : { engine: playground, countsUsage },
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
  const access = accessChecker(config);
  const core = buildEngine(config, pool, tools, access, metrics);
  const missing = missingEngineConfig(config.engine, pool !== undefined);
  // As rotas das ferramentas só se ligam com a configuração completa (incluindo o acesso).
  const engine =
    core === undefined || missing.length > 0 || config.engine.apiSecret === undefined
      ? undefined
      : { engine: core, apiSecret: config.engine.apiSecret, metrics };
  // As memórias só precisam da base de dados e do segredo do Salesforce, não do StepAccess.
  const memories =
    pool === undefined || config.engine.apiSecret === undefined
      ? undefined
      : { memories: new Memories(new PgMemoryStore(pool)), apiSecret: config.engine.apiSecret };

  const engineState = { ready: engine !== undefined, missing };
  const runtime = runtimeFacts(config, pool, engineState, core, memories !== undefined);

  // Alertas: avaliados em intervalo a partir da topologia e das métricas; enviados por webhook.
  const { alerts: alertsCfg } = config;
  const sink =
    alertsCfg.webhook === undefined
      ? new NoopAlertSink()
      : new WebhookAlertSink(alertsCfg.webhook, fetch);
  const leader = pool === undefined ? undefined : new PgLeaderLock(pool);
  const breakers = () => core?.openBreakers() ?? [];
  const topology = (): Promise<Topology> =>
    collectTopology({
      pool,
      runtime,
      tools,
      defaultModel: config.engine.defaultModel,
      defaultFallbackModels: config.engine.fallbackModels,
      metrics,
      breakers,
      alerts: () => monitor.facts(),
    });
  const monitor = new AlertMonitor({
    sink,
    format: alertsCfg.webhook?.format ?? null,
    topology,
    metrics,
    breakers,
    service: { name: 'iris-engine', environment: config.env },
    consoleUrl: alertsCfg.consoleUrl,
    windowMs: alertsCfg.windowMs,
    repeatMs: alertsCfg.repeatMs,
    leader,
    log: warn,
  });

  const admin = buildAdmin(
    config,
    pool,
    tools,
    metrics,
    runtime,
    topology,
    monitor,
    core,
    // Só o StepAccess conta utilização; no modo aberto ou em bypass não há o que contar.
    typeof config.engine.stepAccess === 'object',
  );

  const app = await buildApp({
    config,
    ...(engine && { engine }),
    ...(memories && { memories }),
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
  monitor.start(alertsCfg.evalIntervalMs);
  app.addHook('onClose', async () => {
    monitor.stop();
    await monitor.flush();
    await leader?.release();
  });
  if (pool !== undefined) app.addHook('onClose', async () => pool.end());
  logger = app.log;
  if (engine === undefined) {
    app.log.warn({ missing }, 'motor desligado: falta configuração; só /healthz e /readyz');
  } else {
    if (config.engine.stepAccess === 'bypass') {
      app.log.warn('STEPACCESS_BYPASS ativo: os pedidos não são verificados no StepAccess');
    }
    if (config.engine.stepAccess === 'open') {
      app.log.info(
        'ACCESS_MODE=open: acesso só pelo API_SECRET, sem StepAccess; o custo fica nos logs',
      );
    }
    app.log.info({ tools: core?.tools().map((t) => t.name) }, 'motor pronto');
  }
  if (memories !== undefined) app.log.info('memórias ligadas em /v1/memories');
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
