import type { SettingKey, SettingView } from '../settings/settings.js';
import type { NodeStatus, Topology } from './topology.js';

/**
 * Os cinco adaptadores que ligam o motor ao mundo, descritos para a consola: o que fazem, o que
 * acontece quando falham, que definições têm hoje (e onde se mudam) e o que ainda falta para
 * poderem ser configurados pela API de administração. Os valores são os que estão em vigor;
 * nunca inclui segredos.
 */

export type SettingValue = string | number | boolean | string[] | null;

export interface ModuleSetting {
  key: string;
  label: string;
  description: string;
  /** O valor em vigor. `null` quando não está definido. */
  value: SettingValue;
  /** Onde nasce: base de dados (muda-se pela API), `.env` (reinicia-se o serviço) ou constante no código. */
  source: 'database' | 'env' | 'code';
  /** A rota que o altera hoje; `null` se só se muda no `.env` ou no código. */
  adminPath: string | null;
}

export interface ProposedSetting {
  key: string;
  label: string;
  description: string;
  suggested: string;
}

export interface ModuleInfo {
  /** O nó da topologia (`GET /v1/admin/topology`) a que corresponde. */
  id: string;
  /** A classe que implementa o adaptador. */
  className: string;
  file: string;
  /** A interface do motor que implementa. */
  port: string;
  status: NodeStatus;
  /** Está a ser usado neste servidor (por exemplo, o StepAccess não se usa em ACCESS_MODE=open). */
  active: boolean;
  summary: string;
  description: string;
  /** O que acontece ao pedido quando este módulo falha. */
  onFailure: string;
  /** O que se pode configurar hoje. */
  settings: ModuleSetting[];
  /** O que falta para a API de administração o controlar por inteiro. */
  proposed: ProposedSetting[];
}

export interface ModulesInput {
  topology: Topology;
  /** As definições alteráveis sem reiniciar, como as mostra `GET /v1/admin/settings`. */
  settings: SettingView[];
  access: 'live' | 'open' | 'bypass' | 'missing';
  stepAccess: { origin: string | null; componentUuid: string | null };
  openRouter: { baseUrl: string | null; configured: boolean };
  memories: { org: number; user: number };
}

export interface ModulesReport {
  generatedAt: string;
  modules: ModuleInfo[];
}

const ENV = 'env' as const;
const CODE = 'code' as const;
const DB = 'database' as const;
const SETTINGS_PATH = 'PATCH /v1/admin/settings';

export function describeModules(input: ModulesInput): ModulesReport {
  const node = (id: string): NodeStatus =>
    input.topology.nodes.find((n) => n.id === id)?.status ?? 'off';
  const live = input.access === 'live';
  const { memories } = input;
  const views = new Map(input.settings.map((v) => [v.key, v]));
  const valueOf = (key: SettingKey): SettingValue =>
    (views.get(key)?.value ?? null) as SettingValue;
  /** Uma definição de `/v1/admin/settings`, com o nome que tem neste módulo. */
  const editable = (key: SettingKey, as: string = key): ModuleSetting => {
    const v = views.get(key);
    return {
      key: as,
      label: v?.label ?? key,
      description: v?.description ?? '',
      value: valueOf(key),
      source: v?.source ?? ENV,
      adminPath: SETTINGS_PATH,
    };
  };

  const pgEngineStore: ModuleInfo = {
    id: 'adapter.pgEngineStore',
    className: 'PgEngineStore',
    file: 'src/adapters/postgres-store.ts',
    port: 'EngineStore',
    status: node('adapter.pgEngineStore'),
    active: true,
    summary: 'Lê, em cada pedido, a configuração de uma ferramenta no Postgres.',
    description:
      'Junta numa só consulta o modelo, os modelos de recurso, a temperatura, os limites, ' +
      'o estado (ligada ou desligada) e o prompt ativo da ferramenta. Só lê: quem escreve é a ' +
      'API de administração (`src/admin/tools.ts`). Sem linha em `tool_config`, valem os valores ' +
      'por omissão da ferramenta e do motor.',
    onFailure: 'O pedido falha com 500: sem configuração o motor não sabe que modelo usar.',
    settings: [
      {
        key: 'tool.model',
        label: 'Modelo principal por ferramenta',
        description: 'Código OpenRouter. Sem valor, usa o modelo por omissão do motor.',
        value: valueOf('defaultModel'),
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.fallbackModels',
        label: 'Modelos de recurso por ferramenta',
        description: 'Até 3, por ordem. Sem configuração gravada valem os do motor.',
        value: valueOf('fallbackModels'),
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.temperature',
        label: 'Temperatura',
        description: 'Por ferramenta.',
        value: null,
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.maxOutputTokens',
        label: 'Máximo de tokens de saída',
        description: 'Por ferramenta.',
        value: null,
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.timeoutMs',
        label: 'Tempo máximo de cada chamada ao modelo',
        description: 'Por ferramenta, dentro do teto do pedido (`totalTimeoutMs`).',
        value: null,
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.enabled',
        label: 'Ferramenta ligada',
        description: 'Desligada, os pedidos dão 503.',
        value: null,
        source: DB,
        adminPath: 'PUT /v1/admin/tools/:name/config',
      },
      {
        key: 'tool.prompt',
        label: 'Versões do prompt e versão ativa',
        description: 'As versões publicadas nunca mudam; ativa-se uma.',
        value: null,
        source: DB,
        adminPath: 'POST /v1/admin/tools/:name/prompt-versions',
      },
    ],
    proposed: [
      {
        key: 'cacheTtlSeconds',
        label: 'Cache da configuração',
        description:
          'Hoje há uma consulta ao Postgres em todos os pedidos. Uma cache curta tira-a do caminho crítico; a API de administração invalida-a ao gravar.',
        suggested: '5 s',
      },
      {
        key: 'tool.streamingEnabled',
        label: 'Permitir streaming por ferramenta',
        description:
          'Hoje o streaming depende só do pedido e de a ferramenta o declarar. Um interruptor por ferramenta deixa o admin proibi-lo.',
        suggested: 'true',
      },
    ],
  };

  const pgMemoryStore: ModuleInfo = {
    id: 'adapter.pgMemoryStore',
    className: 'PgMemoryStore',
    file: 'src/adapters/postgres-memory-store.ts',
    port: 'MemoryStore',
    status: node('adapter.pgMemoryStore'),
    active: true,
    summary: 'Guarda e lê as memórias das orgs e dos utilizadores no Postgres.',
    description:
      'Cria, lista, altera e apaga memórias e devolve as que valem para um pedido (as da org e ' +
      'as do utilizador, filtradas pela ferramenta). Os limites são garantidos também pela base de ' +
      'dados, mesmo com inserções simultâneas. As memórias são o único dado de clientes que a IRIS guarda.',
    onFailure: 'O pedido falha com 500; as rotas `/v1/memories` e `/v1/admin/memories` também.',
    settings: [
      editable('memoryMaxChars', 'limits.chars'),
      editable('memoryPerOrg', 'limits.perOrg'),
      editable('memoryPerUser', 'limits.perUser'),
      {
        key: 'memories.org',
        label: 'Memórias de orgs guardadas',
        description: 'Gerem-se pela API de administração.',
        value: memories.org,
        source: DB,
        adminPath: '/v1/admin/memories',
      },
      {
        key: 'memories.user',
        label: 'Memórias de utilizadores guardadas',
        description: 'O administrador só as vê e apaga.',
        value: memories.user,
        source: DB,
        adminPath: '/v1/admin/memories',
      },
    ],
    proposed: [
      {
        key: 'limits.perOrgOverride',
        label: 'Limites próprios por org',
        description:
          'Os limites já se mudam em `/v1/admin/settings`, mas valem para todas as orgs. Falta uma exceção por org.',
        suggested: '500 caracteres · 50 por org · 20 por utilizador',
      },
      {
        key: 'userMemoriesEnabled',
        label: 'Memórias de utilizador ligadas por org',
        description:
          'Deixar uma org desligar as memórias pessoais e ficar só com as regras da empresa.',
        suggested: 'true',
      },
      {
        key: 'retentionDays',
        label: 'Validade das memórias de utilizador',
        description: 'Apagar as que não são usadas há N dias (hoje ficam para sempre).',
        suggested: 'sem validade',
      },
    ],
  };

  const stepAccessClient: ModuleInfo = {
    id: 'adapter.access',
    className: 'StepAccessClient',
    file: 'src/adapters/stepaccess-access.ts',
    port: 'AccessChecker',
    status: node('adapter.access'),
    active: live,
    summary: 'Pergunta ao StepAccess se o utilizador pode usar a IRIS e conta a utilização.',
    description:
      '`GET /v1/access` com a org, o utilizador e o componente IRIS, com autenticação Basic. ' +
      'Cada resposta positiva conta utilização, por isso só corre depois de o pedido estar validado. ' +
      'Falha fechada: qualquer resposta inesperada recusa o pedido. Fora de `ACCESS_MODE=stepaccess` ' +
      'é substituído por `OpenAccessChecker`, que deixa passar tudo.',
    onFailure:
      'Sem resposta ou resposta inesperada: 503 `service_unavailable`. Sem licença: 403 `access_denied`. Limite atingido: 429 `quota_exceeded`.',
    settings: [
      {
        key: 'accessMode',
        label: 'Modo de acesso',
        description: '`stepaccess` (licenças) ou `open` (só o API_SECRET).',
        value: input.access,
        source: ENV,
        adminPath: null,
      },
      {
        key: 'url',
        label: 'URL do StepAccess',
        description: 'Só a origem; as credenciais nunca saem do servidor.',
        value: input.stepAccess.origin,
        source: ENV,
        adminPath: null,
      },
      {
        key: 'componentUuid',
        label: 'Componente IRIS',
        description: 'Identifica a IRIS no StepAccess.',
        value: input.stepAccess.componentUuid,
        source: ENV,
        adminPath: null,
      },
      editable('stepAccessTimeoutMs', 'timeoutMs'),
    ],
    proposed: [
      {
        key: 'test',
        label: 'Testar a ligação',
        description:
          '`POST /v1/admin/modules/stepAccess/test` com uma org e um utilizador de teste, sem contar utilização.',
        suggested: 'ação, não definição',
      },
      {
        key: 'decisionCacheSeconds',
        label: 'Cache curta de decisões positivas',
        description:
          'Evita uma chamada por pedido numa rajada do mesmo utilizador. Atenção: a utilização é contada pelo StepAccess em cada chamada, por isso só com acordo dele.',
        suggested: 'desligada',
      },
    ],
  };

  const usageReporter: ModuleInfo = {
    id: 'adapter.usage',
    className: 'StepAccessUsageReporter',
    file: 'src/adapters/stepaccess-usage.ts',
    port: 'UsageReporter',
    status: node('adapter.usage'),
    active: live,
    summary: 'Envia o custo de cada pedido ao StepAccess, depois de responder.',
    description:
      '`POST /v1/usage/cost` com o custo em dólares, os tokens e o resultado (nunca conteúdo). ' +
      'Corre em segundo plano, sem atrasar nem fazer falhar o pedido. Tenta duas vezes; um 409 conta ' +
      'como entregue (o `requestId` é a chave de idempotência). Se falhar, o evento completo fica no log.',
    onFailure:
      'O pedido não é afetado. O custo perde-se do StepAccess e fica só no log (`stepaccess cost not reported`), sem fila para reenviar.',
    settings: [
      {
        key: 'enabled',
        label: 'Envio ligado',
        description: 'Só existe com o StepAccess configurado.',
        value: live,
        source: ENV,
        adminPath: null,
      },
      {
        key: 'attempts',
        label: 'Tentativas',
        description: 'Constante no código.',
        value: 2,
        source: CODE,
        adminPath: null,
      },
      {
        key: 'retryDelayMs',
        label: 'Espera entre tentativas',
        description: 'Constante no código.',
        value: 1000,
        source: CODE,
        adminPath: null,
      },
      editable('stepAccessUsageTimeoutMs', 'timeoutMs'),
    ],
    proposed: [
      {
        key: 'outbox',
        label: 'Fila persistente de custos por enviar',
        description:
          'Hoje um custo que falha duas vezes só existe no log. Uma tabela `cost_outbox` (só metadados) permitia reenviar sozinho e mostrar quantos estão pendentes. É a lacuna mais séria deste módulo.',
        suggested: 'ligada',
      },
      {
        key: 'retries',
        label: 'Tentativas e espera editáveis',
        description: 'Número de tentativas e espera entre elas.',
        suggested: '2 · 1000 ms',
      },
      {
        key: 'pending',
        label: 'Custos pendentes no estado',
        description: 'Contador em `/v1/admin/status` e aviso na topologia quando a fila cresce.',
        suggested: 'aviso acima de 20',
      },
    ],
  };

  const openRouter: ModuleInfo = {
    id: 'adapter.llm',
    className: 'OpenRouterProvider',
    file: 'src/adapters/openrouter.ts',
    port: 'LlmProvider',
    status: node('adapter.llm'),
    active: input.openRouter.configured,
    summary: 'Chama os modelos de IA através do OpenRouter.',
    description:
      '`POST /chat/completions` com o JSON Schema da ferramenta, só a fornecedores que não guardam nem ' +
      'treinam com os dados (`data_collection: deny`) e que suportam todos os parâmetros. Devolve o texto, ' +
      'o modelo que respondeu, os tokens e o custo. Com `stream: true` no pedido lê a resposta em SSE e ' +
      'entrega cada pedaço ao motor. A cadeia de modelos de recurso, as novas tentativas e o disjuntor ' +
      'vivem no motor (`src/engine/run.ts`), não aqui.',
    onFailure:
      'Fornecedor em baixo: 502 `provider_unavailable`, depois de tentar os modelos de recurso. Tempo esgotado: 504 `timeout`.',
    settings: [
      {
        key: 'baseUrl',
        label: 'URL base',
        description: 'Compatível com a API OpenAI.',
        value: input.openRouter.baseUrl,
        source: ENV,
        adminPath: null,
      },
      editable('defaultModel'),
      editable('fallbackModels'),
      editable('totalTimeoutMs'),
      editable('maxAttempts'),
      editable('breakerThreshold'),
      editable('breakerOpenMs'),
      {
        key: 'dataCollection',
        label: 'Política de dados do fornecedor',
        description: 'Exclui fornecedores que guardam pedidos ou treinam com eles.',
        value: 'deny',
        source: CODE,
        adminPath: null,
      },
      {
        key: 'models',
        label: 'Catálogo de modelos',
        description: 'Os modelos disponíveis, para escolher na configuração de cada ferramenta.',
        value: null,
        source: ENV,
        adminPath: 'GET /v1/admin/models',
      },
    ],
    proposed: [
      {
        key: 'dataCollection',
        label: 'Política de dados',
        description:
          'Manter `deny` por omissão; permitir `allow` apenas por ferramenta e com registo de auditoria.',
        suggested: 'deny',
      },
      {
        key: 'providerRouting',
        label: 'Ordem e lista de fornecedores',
        description:
          'Preferir, permitir ou excluir fornecedores do OpenRouter (`provider.order`, `only`, `ignore`).',
        suggested: 'automático',
      },
      {
        key: 'creditsWarning',
        label: 'Limiar do aviso de créditos',
        description:
          'Na topologia, o OpenRouter passa a `warning` aos 90% do limite da chave (hoje fixo).',
        suggested: '90%',
      },
      {
        key: 'apiKey',
        label: 'Rotação da chave',
        description:
          'Continua a viver no `.env` ou num gestor de segredos; a API de administração só devia mostrar os últimos 4 caracteres e o estado.',
        suggested: 'só leitura',
      },
    ],
  };

  return {
    generatedAt: input.topology.generatedAt,
    modules: [pgEngineStore, pgMemoryStore, stepAccessClient, usageReporter, openRouter],
  };
}
