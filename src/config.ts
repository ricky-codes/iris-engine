import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Único ponto do código que lê `process.env`.
 * O processo não arranca com configuração inválida.
 */
const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  HOST: Type.String({ minLength: 1, default: '0.0.0.0' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  MAX_BODY_BYTES: Type.Integer({ minimum: 1024, default: 1_048_576 }),
  SHUTDOWN_TIMEOUT_MS: Type.Integer({ minimum: 0, default: 10_000 }),
  DATABASE_URL: Type.Optional(Type.String({ pattern: '^postgres(ql)?://' })),
  MIGRATIONS_DIR: Type.String({ minLength: 1, default: 'migrations' }),

  // Segredo partilhado que o Salesforce envia em `Authorization: Bearer …`.
  API_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  // Segredo da API de administração (usado pelo backend do StepAccess). Diferente do API_SECRET.
  ADMIN_API_SECRET: Type.Optional(Type.String({ minLength: 32 })),

  // StepAccess: decide se o utilizador tem acesso e conta a utilização.
  STEPACCESS_URL: Type.Optional(Type.String({ pattern: '^https?://[^\\s]+$' })),
  STEPACCESS_USER: Type.Optional(Type.String({ minLength: 1 })),
  STEPACCESS_PASSWORD: Type.Optional(Type.String({ minLength: 1 })),
  STEPACCESS_COMPONENT_UUID: Type.Optional(
    Type.String({
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    }),
  ),
  STEPACCESS_TIMEOUT_MS: Type.Integer({ minimum: 100, default: 3000 }),
  // Só fora de produção: deixa passar todos os pedidos sem perguntar ao StepAccess.
  STEPACCESS_BYPASS: Type.Boolean({ default: false }),

  // OpenRouter: fornecedor dos modelos de IA.
  OPENROUTER_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  OPENROUTER_BASE_URL: Type.String({
    pattern: '^https?://[^\\s]+$',
    default: 'https://openrouter.ai/api/v1',
  }),
  // Modelo usado quando a ferramenta não tem configuração na base de dados.
  LLM_DEFAULT_MODEL: Type.String({ minLength: 1, default: 'google/gemini-2.5-flash' }),

  // Ferramenta de diagnóstico, para testar a ligação ponta a ponta.
  ENABLE_DIAGNOSTIC_TOOL: Type.Boolean({ default: false }),
});

type Env = Static<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  maxBodyBytes: number;
  shutdownTimeoutMs: number;
  /** Sem URL o serviço arranca sem base de dados (útil em desenvolvimento e testes). */
  databaseUrl: string | undefined;
  migrationsDir: string;
  engine: EngineConfig;
  /** Sem segredo não há API de administração. */
  adminApiSecret: string | undefined;
}

export interface StepAccessConfig {
  url: string;
  user: string;
  password: string;
  componentUuid: string;
  timeoutMs: number;
}

export interface EngineConfig {
  apiSecret: string | undefined;
  /** `bypass`: sem StepAccess (só fora de produção). `undefined`: não configurado. */
  stepAccess: StepAccessConfig | 'bypass' | undefined;
  openRouter: { apiKey: string; baseUrl: string } | undefined;
  defaultModel: string;
  enableDiagnosticTool: boolean;
}

/** O que falta para o motor poder atender pedidos. Vazio = pronto. */
export function missingEngineConfig(engine: EngineConfig, hasDatabase: boolean): string[] {
  const missing: string[] = [];
  if (!hasDatabase) missing.push('DATABASE_URL');
  if (engine.apiSecret === undefined) missing.push('API_SECRET');
  if (engine.stepAccess === undefined)
    missing.push(
      'STEPACCESS_URL, STEPACCESS_USER, STEPACCESS_PASSWORD e STEPACCESS_COMPONENT_UUID (ou STEPACCESS_BYPASS=true fora de produção)',
    );
  if (engine.openRouter === undefined) missing.push('OPENROUTER_API_KEY');
  return missing;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuração inválida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Ignora variáveis vazias para que os valores por omissão se apliquem.
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(EnvSchema.properties)) {
    const value = source[key];
    if (value !== undefined && value !== '') raw[key] = value;
  }

  const withDefaults = Value.Default(EnvSchema, raw);
  const converted = Value.Convert(EnvSchema, withDefaults);

  if (!Value.Check(EnvSchema, converted)) {
    const issues = [...Value.Errors(EnvSchema, converted)].map(
      (e) => `${e.path.slice(1) || '(raiz)'}: ${e.message}`,
    );
    throw new ConfigError(issues);
  }

  if (converted.NODE_ENV === 'production' && converted.DATABASE_URL === undefined) {
    throw new ConfigError(['DATABASE_URL: obrigatório em produção']);
  }
  if (converted.NODE_ENV === 'production' && converted.STEPACCESS_BYPASS) {
    throw new ConfigError(['STEPACCESS_BYPASS: proibido em produção']);
  }

  const stepAccessParts = [
    converted.STEPACCESS_URL,
    converted.STEPACCESS_USER,
    converted.STEPACCESS_PASSWORD,
    converted.STEPACCESS_COMPONENT_UUID,
  ];
  const stepAccessCount = stepAccessParts.filter((v) => v !== undefined).length;
  if (stepAccessCount > 0 && stepAccessCount < stepAccessParts.length) {
    throw new ConfigError([
      'STEPACCESS_URL, STEPACCESS_USER, STEPACCESS_PASSWORD e STEPACCESS_COMPONENT_UUID: ou todos ou nenhum',
    ]);
  }

  const engine: EngineConfig = {
    apiSecret: converted.API_SECRET,
    stepAccess: converted.STEPACCESS_BYPASS
      ? 'bypass'
      : converted.STEPACCESS_URL !== undefined &&
          converted.STEPACCESS_USER !== undefined &&
          converted.STEPACCESS_PASSWORD !== undefined &&
          converted.STEPACCESS_COMPONENT_UUID !== undefined
        ? {
            url: converted.STEPACCESS_URL.replace(/\/+$/, ''),
            user: converted.STEPACCESS_USER,
            password: converted.STEPACCESS_PASSWORD,
            componentUuid: converted.STEPACCESS_COMPONENT_UUID,
            timeoutMs: converted.STEPACCESS_TIMEOUT_MS,
          }
        : undefined,
    openRouter:
      converted.OPENROUTER_API_KEY === undefined
        ? undefined
        : {
            apiKey: converted.OPENROUTER_API_KEY,
            baseUrl: converted.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
          },
    defaultModel: converted.LLM_DEFAULT_MODEL,
    enableDiagnosticTool: converted.ENABLE_DIAGNOSTIC_TOOL,
  };

  if (
    converted.ADMIN_API_SECRET !== undefined &&
    converted.ADMIN_API_SECRET === converted.API_SECRET
  ) {
    throw new ConfigError(['ADMIN_API_SECRET: tem de ser diferente do API_SECRET']);
  }

  if (converted.NODE_ENV === 'production') {
    const missing = missingEngineConfig(engine, true);
    if (missing.length > 0)
      throw new ConfigError(missing.map((m) => `${m}: obrigatório em produção`));
  }

  return {
    env: converted.NODE_ENV,
    host: converted.HOST,
    port: converted.PORT,
    logLevel: converted.LOG_LEVEL,
    maxBodyBytes: converted.MAX_BODY_BYTES,
    shutdownTimeoutMs: converted.SHUTDOWN_TIMEOUT_MS,
    databaseUrl: converted.DATABASE_URL,
    migrationsDir: converted.MIGRATIONS_DIR,
    engine,
    adminApiSecret: converted.ADMIN_API_SECRET,
  };
}
