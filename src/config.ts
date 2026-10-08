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

  return {
    env: converted.NODE_ENV,
    host: converted.HOST,
    port: converted.PORT,
    logLevel: converted.LOG_LEVEL,
    maxBodyBytes: converted.MAX_BODY_BYTES,
    shutdownTimeoutMs: converted.SHUTDOWN_TIMEOUT_MS,
    databaseUrl: converted.DATABASE_URL,
    migrationsDir: converted.MIGRATIONS_DIR,
  };
}
