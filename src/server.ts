import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
import { PgSettingsStore } from './adapters/postgres-settings-store.js';
import { PgOrgKeyStore, SecretBox } from './adapters/postgres-org-key-store.js';
import { OrgKeys } from './auth/org-keys.js';
import type { PublicAuth } from './http/auth.js';
import { StepAccessClient } from './adapters/stepaccess-access.js';
import { StepAccessUsageReporter } from './adapters/stepaccess-usage.js';
import type { AccessChecker } from './engine/access.js';
import { describeModules } from './admin/modules.js';
import { statusReport } from './admin/status.js';
import { collectTopology } from './admin/topology-source.js';
import type { RuntimeFacts, Topology } from './admin/topology.js';
import { createEngine, type Engine } from './engine/engine.js';
import { EngineError } from './engine/errors.js';
import { DEFAULT_MEMORY_LIMITS, Memories } from './engine/memory.js';
import { Metrics } from './engine/metrics.js';
import type { ToolDefinition } from './engine/tool.js';
import type { AdminRoutesOptions, StatusReport } from './http/routes/admin.js';
import { enabledTools } from './tools/index.js';
import { Traces } from './traces/traces.js';
import { createHash } from 'node:crypto';
import { LiveSettings, memoryLimitsOf, type RuntimeSettings } from './settings/settings.js';

// Os clientes externos registam avisos no logger da app, que só existe depois de criada.
let logger: FastifyBaseLogger | undefined;
const warn = (msg: string, data: Record<string, unknown>): void => {
  logger?.warn(data, msg);
};

/** Esta instância: o disjuntor, o limite de pedidos e as métricas são por instância. */
const instanceId = `${hostname()}:${randomUUID().slice(0, 8)}`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

/** Os valores iniciais das definições alteráveis: os do `.env` e, nas memórias, os do código. */
function settingsDefaults(config: AppConfig): RuntimeSettings {
  const { engine: cfg } = config;
  return {
    defaultModel: cfg.defaultModel,
    fallbackModels: cfg.fallbackModels,
    totalTimeoutMs: cfg.totalTimeoutMs,
    maxAttempts: cfg.maxAttempts,
    breakerThreshold: cfg.breaker.threshold,
    breakerOpenMs: cfg.breaker.openMs,
    streamEnabled: cfg.streamEnabled,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    stepAccessTimeoutMs: cfg.stepAccessTimeoutMs,
    stepAccessUsageTimeoutMs: cfg.stepAccessUsageTimeoutMs,
    memoryMaxChars: DEFAULT_MEMORY_LIMITS.chars,
    memoryPerOrg: DEFAULT_MEMORY_LIMITS.perOrg,
    memoryPerUser: DEFAULT_MEMORY_LIMITS.perUser,
    tracesEnabled: true,
    tracesPerTool: 100,
  };
}

function accessChecker(config: AppConfig, settings: LiveSettings): AccessChecker | undefined {
  const sa = config.engine.stepAccess;
  if (sa === undefined) return undefined;
  return sa === 'open' || sa === 'bypass'
    ? new OpenAccessChecker()
    : new StepAccessClient(
        { ...sa, timeoutMs: () => settings.current().stepAccessTimeoutMs },
        fetch,
        warn,
      );
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
  settings: LiveSettings,
  traces: Traces | undefined,
): Engine | undefined {
  const { engine: cfg } = config;
  if (pool === undefined || cfg.openRouter === undefined) return undefined;
  return createEngine({
    // Lidas em cada pedido: o mesmo objeto enquanto nada muda na base de dados.
    settings: () => settings.current(),
    tools,
    access: access ?? noAccess,
    store: new PgEngineStore(pool),
    memories: new PgMemoryStore(pool),
    llm: new OpenRouterProvider(cfg.openRouter, fetch, warn),
    // Cada chamada a um modelo e o que o motor mediu em cada pedido entram nas métricas (só
    // nomes, resultados, contagens e tempos; nunca orgs, utilizadores nem conteúdo).
    onEvent: (e) => {
      if (e.type === 'model_call') {
        const { tool, model, reason, fallback, attempt, durationMs } = e;
        metrics.recordModelCall({ tool, model, reason, fallback, attempt, durationMs });
      } else if (e.type === 'run_completed') {
        metrics.recordRun({
          tool: e.tool,
          timings: e.timings,
          orgMemories: e.orgMemories,
          userMemories: e.userMemories,
          checkedAccess: true,
          models: e.calls.filter((c) => c.reason !== 'skipped_breaker').map((c) => c.model),
        });
      } else {
        const reachedAccess = !['request', 'gate', 'rate'].includes(e.stage);
        metrics.recordRun({
          tool: e.tool,
          timings: e.timings,
          checkedAccess: reachedAccess,
          stoppedAt: e.stage,
          models: e.calls.filter((c) => c.reason !== 'skipped_breaker').map((c) => c.model),
        });
      }
      traces?.record(e);
    },
    ...(cfg.stepAccess !== undefined &&
      typeof cfg.stepAccess === 'object' && {
        usage: new StepAccessUsageReporter(
          { ...cfg.stepAccess, timeoutMs: () => settings.current().stepAccessUsageTimeoutMs },
          fetch,
          warn,
        ),
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
  settings: LiveSettings,
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
        defaultModel: settings.current().defaultModel,
        maxAttempts: core?.settings.maxAttempts ?? settings.current().maxAttempts,
      },
      access: sa === undefined ? 'missing' : typeof sa === 'string' ? sa : 'live',
      openRouter: cfg.openRouter === undefined ? 'missing' : 'configured',
      routes: { tools: engine.ready, memories: memoriesOn },
      auth: cfg.authMode,
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
  playground: Engine | undefined,
  countsUsage: boolean,
  settings: LiveSettings,
  traces: Traces | undefined,
  orgKeys: OrgKeys | undefined,
): AdminRoutesOptions | undefined {
  if (config.adminApiSecret === undefined || pool === undefined) return undefined;
  const { engine: cfg } = config;

  const status = async (): Promise<StatusReport> =>
    statusReport({
      runtime: await runtime(),
      tools: tools.map((t) => t.name),
      defaultModel: settings.current().defaultModel,
      diagnosticTool: cfg.enableDiagnosticTool,
    });

  return {
    secret: config.adminApiSecret,
    pool,
    tools,
    settings,
    breakers:
      playground === undefined
        ? undefined
        : { status: () => playground.breakers(), reset: (m) => playground.resetBreakers(m) },
    instanceId,
    traces,
    metrics,
    status,
    topology,
    modules: async () => {
      const t = await topology();
      const sa = cfg.stepAccess;
      const mem = t.nodes.find((n) => n.id === 'core.memories')?.details;
      return describeModules({
        topology: t,
        settings: settings.describe(),
        access: sa === undefined ? 'missing' : typeof sa === 'string' ? sa : 'live',
        stepAccess:
          typeof sa === 'object'
            ? { origin: new URL(sa.url).origin, componentUuid: sa.componentUuid }
            : { origin: null, componentUuid: null },
        openRouter: {
          baseUrl: cfg.openRouter?.baseUrl ?? null,
          configured: cfg.openRouter !== undefined,
        },
        memories: {
          org: typeof mem?.['org'] === 'number' ? mem['org'] : 0,
          user: typeof mem?.['user'] === 'number' ? mem['user'] : 0,
        },
        auth: { mode: cfg.authMode, orgKeysConfigured: orgKeys !== undefined },
      });
    },
    orgKeys,
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

  // Definições alteráveis sem reiniciar: as do `.env` por omissão, as da base de dados por cima.
  const settings = new LiveSettings(
    settingsDefaults(config),
    pool === undefined ? undefined : new PgSettingsStore(pool),
    warn,
  );
  await settings.refresh();
  settings.start();

  const metrics = new Metrics();
  const access = accessChecker(config, settings);
  // Os últimos pedidos (só metadados, em memória), para o dashboard. Só com a API de admin, que
  // é quem os mostra; o id opaco da org usa uma chave derivada do segredo de admin.
  const traces =
    config.adminApiSecret === undefined
      ? undefined
      : new Traces({
          enabled: () => settings.current().tracesEnabled,
          perTool: () => settings.current().tracesPerTool,
          orgKey: createHash('sha256').update(`iris-traces:${config.adminApiSecret}`).digest('hex'),
        });
  const core = buildEngine(config, pool, tools, access, metrics, settings, traces);
  const missing = missingEngineConfig(
    config.engine,
    pool !== undefined,
    config.orgKeyEncryptionKey,
  );
  // As chaves das orgs: verificam os tokens das rotas públicas e gerem-se pela API de admin.
  const orgKeys =
    pool === undefined || config.orgKeyEncryptionKey === undefined
      ? undefined
      : new OrgKeys(
          new PgOrgKeyStore(pool, new SecretBox(config.orgKeyEncryptionKey)),
          undefined,
          (err) => {
            warn('chaves das orgs: falhou a gravação do último uso', {
              err: err instanceof Error ? err.message : String(err),
            });
          },
        );
  // Como as rotas públicas autenticam quem chama (ver AUTH_MODE).
  const auth: PublicAuth | undefined =
    config.engine.authMode === 'token'
      ? orgKeys === undefined
        ? undefined
        : { orgKeys }
      : config.engine.apiSecret === undefined
        ? undefined
        : { apiSecret: config.engine.apiSecret };
  // As rotas das ferramentas só se ligam com a configuração completa (incluindo o acesso).
  const engine =
    core === undefined || missing.length > 0 || auth === undefined
      ? undefined
      : { ...auth, engine: core, metrics };
  // As memórias só precisam da base de dados e da autenticação, não do StepAccess.
  const memories =
    pool === undefined || auth === undefined
      ? undefined
      : {
          ...auth,
          memories: new Memories(new PgMemoryStore(pool), () => memoryLimitsOf(settings.current())),
        };

  const engineState = { ready: engine !== undefined, missing };
  const runtime = runtimeFacts(config, pool, engineState, core, memories !== undefined, settings);

  const topology = (): Promise<Topology> =>
    collectTopology({
      pool,
      runtime,
      tools,
      settings: () => settings.current(),
      metrics,
      breakers: () => core?.openBreakers() ?? [],
      orgKeys,
    });

  const admin = buildAdmin(
    config,
    pool,
    tools,
    metrics,
    runtime,
    topology,
    core,
    // Só o StepAccess conta utilização; no modo aberto ou em bypass não há o que contar.
    typeof config.engine.stepAccess === 'object',
    settings,
    traces,
    orgKeys,
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
  app.addHook('onClose', async () => {
    settings.stop();
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
    if (config.engine.authMode === 'shared_secret') {
      app.log.warn(
        'AUTH_MODE=shared_secret: o orgId e o userId vêm no pedido, protegidos só pelo API_SECRET',
      );
    }
    app.log.info(
      { tools: core?.tools().map((t) => t.name), auth: config.engine.authMode },
      'motor pronto',
    );
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
