/**
 * A IRIS descrita a si própria: os módulos, como estão ligados e o estado de cada um,
 * para a consola de administração desenhar e configurar o motor. Tudo sai do que está
 * a correr (configuração, verificações, catálogo, métricas); nada é desenhado à mão.
 */

export type CheckStatus = 'ok' | 'failed' | 'not_configured';

export interface CheckFact {
  status: CheckStatus;
  latencyMs: number | null;
  detail?: string;
  /** Só no OpenRouter: dólares gastos e limite da chave (`null` = sem limite). */
  credits?: { usage: number | null; limit: number | null };
}

/** `live`: StepAccess a verificar cada pedido · `open`: só a credencial da API · `bypass`: não verifica (desenvolvimento). */
export type AccessMode = 'live' | 'open' | 'bypass' | 'missing';

/** O que só o servidor sabe: configuração em vigor, rotas ligadas e verificações das dependências. */
export interface RuntimeFacts {
  service: {
    name: string;
    version: string;
    environment: string;
    startedAt: string;
    uptimeSeconds: number;
  };
  engine: { ready: boolean; missing: string[]; defaultModel: string; maxAttempts: number };
  access: AccessMode;
  openRouter: 'configured' | 'missing';
  routes: { tools: boolean; memories: boolean };
  /** Como as rotas públicas autenticam quem chama (AUTH_MODE). Sem valor: segredo partilhado. */
  auth?: 'token' | 'shared_secret';
  checks: { database: CheckFact; stepAccess: CheckFact; openRouter: CheckFact };
}

export interface ToolFact {
  name: string;
  implemented: boolean;
  version: number | null;
  enabled: boolean;
  model: string | null;
  modelSource: 'database' | 'default' | null;
  prompt: { source: 'database' | 'code' | 'none'; version: number | null };
  /** Modelos de recurso, por ordem. */
  fallbackModels: string[];
  /** Pedidos desde o arranque (métricas em memória). */
  requests: number;
  failed: number;
  /** Pedidos que só tiveram resposta com um modelo de recurso. */
  fallbacks: number;
}

/** Modelos que o disjuntor está a saltar agora. */
export interface BreakerFact {
  model: string;
  openSince: string;
  openUntil: string;
}

export interface TopologyInput {
  runtime: RuntimeFacts;
  tools: ToolFact[];
  breakers: BreakerFact[];
  memories: {
    org: number;
    user: number;
    limits: { chars: number; perOrg: number; perUser: number };
  };
}

/** As camadas, de quem chama até aos serviços externos. */
export type Layer = 'client' | 'http' | 'core' | 'port' | 'adapter' | 'external' | 'tool';

/** `ok` · `warning`: funciona com reservas · `error`: não funciona · `off`: desligado ou não configurado. */
export type NodeStatus = 'ok' | 'warning' | 'error' | 'off';

/** Onde se muda a configuração de um nó: pela API de administração ou só no `.env` do servidor. */
/**
 * Onde se muda um nó. Com `path: '/v1/admin/settings'`, `keys` diz que definições lhe dizem
 * respeito; com `where: 'env'`, `keys` são as variáveis de ambiente.
 */
export type ConfigureAt =
  { where: 'admin_api'; path: string; keys?: string[] } | { where: 'env'; keys: string[] };

export interface TopologyNode {
  id: string;
  layer: Layer;
  label: string;
  status: NodeStatus;
  /** Uma frase sobre o estado, para mostrar ao lado do nó. */
  summary: string;
  details: Record<string, string | number | boolean | null>;
  configure: ConfigureAt | null;
}

export interface TopologyEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Topology {
  generatedAt: string;
  service: RuntimeFacts['service'];
  /** O pior estado de todos os nós ligados (os `off` não contam). */
  overall: NodeStatus;
  layers: Layer[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

const LAYERS: Layer[] = ['client', 'http', 'core', 'port', 'adapter', 'external', 'tool'];
const RANK: Record<NodeStatus, number> = { off: 0, ok: 1, warning: 2, error: 3 };

const fromCheck = (c: CheckFact): NodeStatus =>
  c.status === 'ok' ? 'ok' : c.status === 'failed' ? 'error' : 'off';

const checkSummary = (c: CheckFact, okText: string): string =>
  c.status === 'ok'
    ? `${okText}${c.latencyMs === null ? '' : ` · ${String(c.latencyMs)} ms`}`
    : c.status === 'failed'
      ? `Falhou: ${c.detail ?? 'sem detalhe'}`
      : (c.detail ?? 'Não configurado');

const ACCESS_ADAPTER: Record<AccessMode, { label: string; status: NodeStatus; summary: string }> = {
  live: {
    label: 'StepAccessClient',
    status: 'ok',
    summary: 'Confirma a licença e conta cada pedido',
  },
  open: {
    label: 'OpenAccessChecker',
    status: 'ok',
    summary: 'Modo aberto: o acesso é só pela credencial da API',
  },
  bypass: {
    label: 'OpenAccessChecker',
    status: 'warning',
    summary: 'STEPACCESS_BYPASS: não verifica licenças (só desenvolvimento)',
  },
  missing: { label: 'sem adaptador', status: 'error', summary: 'StepAccess não configurado' },
};

const ENV_ACCESS: ConfigureAt = {
  where: 'env',
  keys: [
    'ACCESS_MODE',
    'STEPACCESS_URL',
    'STEPACCESS_USER',
    'STEPACCESS_PASSWORD',
    'STEPACCESS_COMPONENT_UUID',
  ],
};
const ENV_OPENROUTER: ConfigureAt = {
  where: 'env',
  keys: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'],
};
const ENV_DATABASE: ConfigureAt = { where: 'env', keys: ['DATABASE_URL'] };

/** O nome do modelo sem o fornecedor (`google/gemini-2.5-flash` → `gemini-2.5-flash`). */
const shortModel = (m: string): string => m.slice(m.indexOf('/') + 1);

/** A cadeia de modelos de uma ferramenta, para mostrar: `gemini-2.5-flash → gpt-4.1-mini`. */
const chainText = (t: ToolFact): string | null =>
  t.model === null ? null : [t.model, ...t.fallbackModels].map(shortModel).join(' → ');

/** Pelo menos 5 pedidos e 20% ou mais servidos por um modelo de recurso. */
export const FALLBACK_WARNING = { minRequests: 5, rate: 0.2 };

function toolNode(t: ToolFact): TopologyNode {
  const failureRate = t.requests === 0 ? 0 : t.failed / t.requests;
  const status: NodeStatus = !t.implemented
    ? 'off'
    : !t.enabled
      ? 'off'
      : t.requests >= 5 && failureRate >= 0.2
        ? 'warning'
        : 'ok';
  const summary = !t.implemented
    ? 'No catálogo, sem implementação neste servidor'
    : !t.enabled
      ? 'Desligada: os pedidos dão 503'
      : status === 'warning'
        ? `${String(Math.round(failureRate * 100))}% dos pedidos falharam desde o arranque`
        : `Ligada${t.model === null ? '' : ` · ${t.model}`}`;
  return {
    id: `tool.${t.name}`,
    layer: 'tool',
    label: t.version === null ? t.name : `${t.name} v${String(t.version)}`,
    status,
    summary,
    details: {
      implemented: t.implemented,
      enabled: t.enabled,
      model: t.model,
      modelSource: t.modelSource,
      prompt:
        t.prompt.source === 'database'
          ? `base de dados v${String(t.prompt.version)}`
          : t.prompt.source === 'code'
            ? 'código'
            : 'nenhum',
      requests: t.requests,
      failed: t.failed,
      fallbacks: t.fallbacks,
      chain: chainText(t),
    },
    configure: { where: 'admin_api', path: `/v1/admin/tools/${t.name}` },
  };
}

export function buildTopology(input: TopologyInput, now: Date = new Date()): Topology {
  const { runtime: rt, tools, memories } = input;
  const { checks } = rt;
  const db = fromCheck(checks.database);
  const routeStatus = (on: boolean): NodeStatus => (on ? 'ok' : 'off');
  const credits = checks.openRouter.credits;
  const nearLimit =
    credits?.limit != null && credits.usage != null && credits.usage >= credits.limit * 0.9;
  const openRouter: NodeStatus =
    rt.openRouter === 'missing'
      ? 'error'
      : nearLimit && checks.openRouter.status === 'ok'
        ? 'warning'
        : fromCheck(checks.openRouter);
  // Os modelos: a cadeia é a mesma em todas as ferramentas, ou "várias".
  const live = tools.filter((t) => t.implemented);
  const chains = [...new Set(live.map(chainText).filter((c): c is string => c !== null))];
  const llmRequests = live.reduce((n, t) => n + t.requests, 0);
  const llmFallbacks = live.reduce((n, t) => n + t.fallbacks, 0);
  const manyFallbacks =
    llmRequests >= FALLBACK_WARNING.minRequests &&
    llmFallbacks / llmRequests >= FALLBACK_WARNING.rate;
  const breakers = input.breakers;
  const llmAdapter: NodeStatus =
    openRouter === 'ok' && (manyFallbacks || breakers.length > 0) ? 'warning' : openRouter;
  const accessAdapter = ACCESS_ADAPTER[rt.access];
  const access: NodeStatus =
    rt.access === 'live' ? fromCheck(checks.stepAccess) : accessAdapter.status;
  const engine: NodeStatus = rt.engine.ready ? 'ok' : 'error';
  const usageLive = rt.access === 'live';
  const publicAuth = rt.auth === 'token' ? 'token da org (JWT)' : 'API_SECRET';

  const nodes: TopologyNode[] = [
    // quem chama
    {
      id: 'client.salesforce',
      layer: 'client',
      label: 'Salesforce',
      status: rt.routes.tools || rt.routes.memories ? 'ok' : 'off',
      summary: 'Componente IRIS: ferramentas e memórias do utilizador',
      details: {},
      configure: null,
    },
    {
      id: 'client.console',
      layer: 'client',
      label: 'Consola de administração',
      status: 'ok',
      summary: 'Gere prompts, configuração e memórias',
      details: {},
      configure: null,
    },
    // camada HTTP
    {
      id: 'http.tools',
      layer: 'http',
      label: '/v1/tools',
      status: routeStatus(rt.routes.tools),
      summary: rt.routes.tools
        ? `Ligada · Bearer ${publicAuth}`
        : 'Desligada: falta configuração do motor',
      details: { auth: publicAuth },
      configure: rt.routes.tools ? null : { where: 'env', keys: rt.engine.missing },
    },
    {
      id: 'http.memories',
      layer: 'http',
      label: '/v1/memories',
      status: routeStatus(rt.routes.memories),
      summary: rt.routes.memories
        ? 'Ligada · não conta utilização'
        : `Desligada: falta DATABASE_URL ou ${rt.auth === 'token' ? 'ORG_KEY_ENCRYPTION_KEY' : 'API_SECRET'}`,
      details: { auth: publicAuth, countsUsage: false },
      configure: null,
    },
    {
      id: 'http.admin',
      layer: 'http',
      label: '/v1/admin',
      status: 'ok',
      summary: 'Ligada · Bearer ADMIN_API_SECRET',
      details: { auth: 'ADMIN_API_SECRET' },
      configure: null,
    },
    // núcleo
    {
      id: 'core.engine',
      layer: 'core',
      label: 'Engine.run',
      status: engine,
      summary: rt.engine.ready
        ? `Pronto · ${String(tools.filter((t) => t.implemented).length)} ferramenta(s)`
        : `Desligado: falta ${rt.engine.missing.join(', ')}`,
      details: { defaultModel: rt.engine.defaultModel, maxAttempts: rt.engine.maxAttempts },
      configure: {
        where: 'admin_api',
        path: '/v1/admin/settings',
        keys: [
          'defaultModel',
          'fallbackModels',
          'totalTimeoutMs',
          'maxAttempts',
          'breakerThreshold',
          'breakerOpenMs',
          'streamEnabled',
          'rateLimitPerMinute',
        ],
      },
    },
    {
      id: 'core.memories',
      layer: 'core',
      label: 'Memories',
      status: db === 'ok' ? 'ok' : db === 'off' ? 'off' : 'error',
      summary: `${String(memories.org)} da org · ${String(memories.user)} de utilizadores`,
      details: {
        org: memories.org,
        user: memories.user,
        maxChars: memories.limits.chars,
        perOrg: memories.limits.perOrg,
        perUser: memories.limits.perUser,
      },
      configure: { where: 'admin_api', path: '/v1/admin/memories' },
    },
    // interfaces do núcleo
    {
      id: 'port.engineStore',
      layer: 'port',
      label: 'EngineStore',
      status: db,
      summary: 'Configuração e prompts das ferramentas',
      details: {},
      configure: null,
    },
    {
      id: 'port.memoryStore',
      layer: 'port',
      label: 'MemoryStore',
      status: db,
      summary: 'Onde vivem as memórias',
      details: {},
      configure: null,
    },
    {
      id: 'port.access',
      layer: 'port',
      label: 'AccessChecker',
      status: access,
      summary: 'Quem pode usar',
      details: {},
      configure: null,
    },
    {
      id: 'port.usage',
      layer: 'port',
      label: 'UsageReporter',
      status: usageLive ? 'ok' : 'off',
      summary: 'Para onde vai o custo',
      details: {},
      configure: null,
    },
    {
      id: 'port.llm',
      layer: 'port',
      label: 'LlmProvider',
      status: openRouter,
      summary: 'Fornecedor de modelos',
      details: {},
      configure: null,
    },
    // adaptadores
    {
      id: 'adapter.pgEngineStore',
      layer: 'adapter',
      label: 'PgEngineStore',
      status: db,
      summary: 'Lê a configuração no Postgres',
      details: {},
      configure: null,
    },
    {
      id: 'adapter.pgMemoryStore',
      layer: 'adapter',
      label: 'PgMemoryStore',
      status: db,
      summary: 'Guarda as memórias no Postgres',
      details: {},
      configure: null,
    },
    {
      id: 'adapter.access',
      layer: 'adapter',
      label: accessAdapter.label,
      status: access,
      summary: accessAdapter.summary,
      details: { mode: rt.access },
      configure: ENV_ACCESS,
    },
    {
      id: 'adapter.usage',
      layer: 'adapter',
      label: usageLive ? 'StepAccessUsageReporter' : 'sem envio',
      status: usageLive ? 'ok' : 'off',
      summary: usageLive
        ? 'Envia o custo de cada pedido ao StepAccess'
        : 'O custo de cada pedido fica só nos logs',
      details: {},
      configure: null,
    },
    {
      id: 'adapter.llm',
      layer: 'adapter',
      label: 'OpenRouterProvider',
      status: llmAdapter,
      summary:
        rt.openRouter === 'missing'
          ? 'OPENROUTER_API_KEY em falta'
          : breakers.length > 0
            ? `Disjuntor aberto: ${breakers.map((b) => shortModel(b.model)).join(', ')}`
            : manyFallbacks
              ? `${String(Math.round((llmFallbacks / llmRequests) * 100))}% dos pedidos servidos por modelos de recurso`
              : 'JSON Schema · sem fornecedores que guardem dados',
      details: {
        chain: chains.length === 0 ? null : chains.length === 1 ? (chains[0] ?? null) : 'várias',
        fallbacks: llmFallbacks,
        // Quantos modelos estão a ser saltados; o estado de cada um está em GET /v1/admin/breakers.
        openBreakers: breakers.length,
      },
      configure: ENV_OPENROUTER,
    },
    // serviços externos
    {
      id: 'external.postgres',
      layer: 'external',
      label: 'Postgres',
      status: db,
      summary: checkSummary(checks.database, 'Ligado'),
      details: { latencyMs: checks.database.latencyMs, persistent: true },
      configure: ENV_DATABASE,
    },
    {
      id: 'external.stepaccess',
      layer: 'external',
      label: 'StepAccess',
      status: rt.access === 'live' ? fromCheck(checks.stepAccess) : 'off',
      summary: checkSummary(checks.stepAccess, 'Ligado'),
      details: { latencyMs: checks.stepAccess.latencyMs },
      configure: ENV_ACCESS,
    },
    {
      id: 'external.openrouter',
      layer: 'external',
      label: 'OpenRouter',
      status: openRouter,
      summary: nearLimit
        ? `Créditos quase no limite (${String(credits.usage)} de ${String(credits.limit)} USD)`
        : checkSummary(checks.openRouter, 'Chave válida'),
      details: {
        latencyMs: checks.openRouter.latencyMs,
        creditsUsedUsd: credits?.usage ?? null,
        creditsLimitUsd: credits?.limit ?? null,
      },
      configure: ENV_OPENROUTER,
    },
    // ferramentas
    ...tools.map(toolNode),
  ];

  const edges: TopologyEdge[] = [
    { from: 'client.salesforce', to: 'http.tools' },
    { from: 'client.salesforce', to: 'http.memories' },
    { from: 'client.console', to: 'http.admin' },
    { from: 'http.tools', to: 'core.engine', label: 'run' },
    { from: 'http.memories', to: 'core.memories' },
    { from: 'http.admin', to: 'core.memories' },
    { from: 'http.admin', to: 'core.engine', label: 'playground' },
    { from: 'http.admin', to: 'external.postgres', label: 'configuração e prompts' },
    { from: 'core.engine', to: 'port.engineStore' },
    { from: 'core.engine', to: 'port.memoryStore', label: 'memórias do pedido' },
    { from: 'core.engine', to: 'port.access' },
    { from: 'core.engine', to: 'port.usage' },
    { from: 'core.engine', to: 'port.llm' },
    { from: 'core.memories', to: 'port.memoryStore' },
    { from: 'port.engineStore', to: 'adapter.pgEngineStore' },
    { from: 'port.memoryStore', to: 'adapter.pgMemoryStore' },
    { from: 'port.access', to: 'adapter.access' },
    { from: 'port.usage', to: 'adapter.usage' },
    { from: 'port.llm', to: 'adapter.llm' },
    { from: 'adapter.pgEngineStore', to: 'external.postgres' },
    { from: 'adapter.pgMemoryStore', to: 'external.postgres' },
    ...(rt.access === 'live'
      ? [
          { from: 'adapter.access', to: 'external.stepaccess', label: 'GET /v1/access' },
          { from: 'adapter.usage', to: 'external.stepaccess', label: 'POST /v1/usage/cost' },
        ]
      : []),
    { from: 'adapter.llm', to: 'external.openrouter' },
    ...tools
      .filter((t) => t.implemented)
      .map((t) => ({ from: `tool.${t.name}`, to: 'core.engine', label: 'registada' })),
  ];

  const overall = nodes.reduce<NodeStatus>(
    (worst, n) => (RANK[n.status] > RANK[worst] ? n.status : worst),
    'ok',
  );

  return {
    generatedAt: now.toISOString(),
    service: rt.service,
    overall,
    layers: LAYERS,
    nodes,
    edges,
  };
}
