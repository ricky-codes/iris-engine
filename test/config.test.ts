import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const STEPACCESS = {
  STEPACCESS_URL: 'https://access.example.com',
  STEPACCESS_USER: 'iris',
  STEPACCESS_PASSWORD: 'segredo',
  STEPACCESS_COMPONENT_UUID: '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
};
const PRODUCTION_NO_STEPACCESS = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  AUTH_MODE: 'shared_secret',
  API_SECRET: 'x'.repeat(32),
  OPENROUTER_API_KEY: 'sk-or-teste',
};
const PRODUCTION = { ...PRODUCTION_NO_STEPACCESS, ...STEPACCESS };

describe('loadConfig', () => {
  it('aplica os valores por omissão', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      env: 'development',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      maxBodyBytes: 1_048_576,
      shutdownTimeoutMs: 10_000,
      databaseUrl: undefined,
      migrationsDir: 'migrations',
      engine: {
        authMode: 'token',
        apiSecret: undefined,
        stepAccess: undefined,
        openRouter: undefined,
        defaultModel: 'google/gemini-2.5-flash',
        fallbackModels: [],
        totalTimeoutMs: 30_000,
        maxAttempts: 2,
        breaker: { threshold: 3, openMs: 60_000 },
        streamEnabled: true,
        rateLimitPerMinute: 0,
        stepAccessTimeoutMs: 3000,
        stepAccessUsageTimeoutMs: 10_000,
        enableDiagnosticTool: false,
      },
      adminApiSecret: undefined,
      orgKeyEncryptionKey: undefined,
    });
  });

  describe('autenticação das rotas públicas', () => {
    const KEY = Buffer.alloc(32, 7).toString('base64');
    const TOKEN_PRODUCTION = {
      ...PRODUCTION,
      AUTH_MODE: 'token',
      API_SECRET: '',
      ORG_KEY_ENCRYPTION_KEY: KEY,
    };

    it('por omissão usa tokens das orgs, com a chave mestra em base64 (32 bytes)', () => {
      const config = loadConfig({ ORG_KEY_ENCRYPTION_KEY: KEY });
      expect(config.engine.authMode).toBe('token');
      expect(config.orgKeyEncryptionKey).toEqual(Buffer.alloc(32, 7));
    });

    it('recusa uma chave mestra que não tenha 32 bytes', () => {
      expect(() =>
        loadConfig({ ORG_KEY_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
      ).toThrow(/ORG_KEY_ENCRYPTION_KEY/);
      expect(() => loadConfig({ ORG_KEY_ENCRYPTION_KEY: 'não é base64!' })).toThrow(
        /ORG_KEY_ENCRYPTION_KEY/,
      );
    });

    it('em produção, com tokens, exige a chave mestra e dispensa o API_SECRET', () => {
      expect(loadConfig(TOKEN_PRODUCTION).engine.authMode).toBe('token');
      expect(() => loadConfig({ ...TOKEN_PRODUCTION, ORG_KEY_ENCRYPTION_KEY: '' })).toThrow(
        /ORG_KEY_ENCRYPTION_KEY: obrigatório em produção/,
      );
    });

    it('com o segredo partilhado exige o API_SECRET', () => {
      expect(() => loadConfig({ ...PRODUCTION, API_SECRET: '' })).toThrow(/API_SECRET/);
    });
  });

  it('converte números a partir de strings', () => {
    const config = loadConfig({ PORT: '3000', MAX_BODY_BYTES: '2048' });
    expect(config.port).toBe(3000);
    expect(config.maxBodyBytes).toBe(2048);
  });

  it('trata variáveis vazias como ausentes', () => {
    expect(loadConfig({ PORT: '' }).port).toBe(8080);
  });

  it('exige DATABASE_URL em produção', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    const config = loadConfig({ ...PRODUCTION });
    expect(config.databaseUrl).toBe('postgres://u:p@localhost:5432/d');
  });

  it('em produção exige o motor completo e proíbe o atalho do StepAccess', () => {
    // Variáveis vazias contam como ausentes.
    expect(() => loadConfig({ ...PRODUCTION, API_SECRET: '' })).toThrow(/API_SECRET/);
    expect(() => loadConfig({ ...PRODUCTION, OPENROUTER_API_KEY: '' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(() => loadConfig({ ...PRODUCTION, STEPACCESS_BYPASS: 'true' })).toThrow(
      /STEPACCESS_BYPASS/,
    );
  });

  it('o StepAccess configura-se por inteiro ou nada', () => {
    expect(() => loadConfig({ STEPACCESS_URL: 'https://access.example.com' })).toThrow(
      /todos ou nenhum/,
    );
    const config = loadConfig({ ...STEPACCESS, STEPACCESS_URL: 'https://access.example.com/' });
    expect(config.engine.stepAccess).toEqual({
      url: 'https://access.example.com',
      user: 'iris',
      password: 'segredo',
      componentUuid: '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
    });
  });

  it('o atalho do StepAccess e a ferramenta de diagnóstico ligam-se com "true"', () => {
    const config = loadConfig({ STEPACCESS_BYPASS: 'true', ENABLE_DIAGNOSTIC_TOOL: 'true' });
    expect(config.engine.stepAccess).toBe('bypass');
    expect(config.engine.enableDiagnosticTool).toBe(true);
  });

  it('ACCESS_MODE=open: em produção chega o API_SECRET, sem StepAccess', () => {
    const rest = PRODUCTION_NO_STEPACCESS;
    expect(() => loadConfig(rest)).toThrow(/STEPACCESS_URL/);
    expect(loadConfig({ ...rest, ACCESS_MODE: 'open' }).engine.stepAccess).toBe('open');
    // O resto do motor continua obrigatório.
    expect(() => loadConfig({ ...rest, ACCESS_MODE: 'open', API_SECRET: '' })).toThrow(
      /API_SECRET/,
    );
  });

  it('ACCESS_MODE=open não se mistura com o StepAccess nem com o atalho', () => {
    expect(() => loadConfig({ ACCESS_MODE: 'open', ...STEPACCESS })).toThrow(
      /não se usa com ACCESS_MODE=open/,
    );
    expect(() => loadConfig({ ACCESS_MODE: 'open', STEPACCESS_BYPASS: 'true' })).toThrow(
      /STEPACCESS_BYPASS: não se usa/,
    );
    expect(() => loadConfig({ ACCESS_MODE: 'aberto' })).toThrow(/ACCESS_MODE/);
    expect(
      loadConfig({ ...STEPACCESS, ACCESS_MODE: 'stepaccess' }).engine.stepAccess,
    ).toMatchObject({ url: 'https://access.example.com' });
  });

  it('modelos de recurso por omissão: lista separada por vírgulas, até 3, sem o principal', () => {
    expect(
      loadConfig({ LLM_FALLBACK_MODELS: ' openai/gpt-4.1-mini , anthropic/claude-haiku-4.5,' })
        .engine.fallbackModels,
    ).toEqual(['openai/gpt-4.1-mini', 'anthropic/claude-haiku-4.5']);
    expect(() => loadConfig({ LLM_FALLBACK_MODELS: 'a,b,c,d' })).toThrow(/no máximo 3/);
    expect(() => loadConfig({ LLM_FALLBACK_MODELS: 'a,a' })).toThrow(/repetidos/);
    expect(() => loadConfig({ LLM_DEFAULT_MODEL: 'x/y', LLM_FALLBACK_MODELS: 'a,x/y' })).toThrow(
      /LLM_DEFAULT_MODEL/,
    );
  });

  it('o teto de tempo do pedido fica entre 2 e 115 s', () => {
    expect(loadConfig({ LLM_TOTAL_TIMEOUT_MS: '45000' }).engine.totalTimeoutMs).toBe(45_000);
    expect(() => loadConfig({ LLM_TOTAL_TIMEOUT_MS: '1000' })).toThrow(/LLM_TOTAL_TIMEOUT_MS/);
    expect(() => loadConfig({ LLM_TOTAL_TIMEOUT_MS: '120000' })).toThrow(/LLM_TOTAL_TIMEOUT_MS/);
  });

  it('o segredo de admin é opcional, mas tem de ser diferente do API_SECRET', () => {
    expect(loadConfig({}).adminApiSecret).toBeUndefined();
    expect(loadConfig({ ADMIN_API_SECRET: 'b'.repeat(32) }).adminApiSecret).toBe('b'.repeat(32));
    expect(() =>
      loadConfig({ API_SECRET: 'c'.repeat(32), ADMIN_API_SECRET: 'c'.repeat(32) }),
    ).toThrow(/diferente/);
  });

  it('o segredo da API tem pelo menos 32 caracteres', () => {
    expect(() => loadConfig({ API_SECRET: 'curto' })).toThrow(/API_SECRET/);
  });

  it('rejeita um DATABASE_URL que não é postgres', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('rejeita configuração inválida com a lista de problemas', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: 'abc', NODE_ENV: 'staging' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues.join('\n');
    expect(issues).toContain('PORT');
    expect(issues).toContain('NODE_ENV');
  });

  describe('variáveis do motor', () => {
    it('lê as tentativas, o disjuntor, o streaming, o limite de pedidos e o tempo do custo', () => {
      const config = loadConfig({
        ...STEPACCESS,
        LLM_MAX_ATTEMPTS: '3',
        LLM_BREAKER_THRESHOLD: '5',
        LLM_BREAKER_OPEN_MS: '120000',
        STREAM_ENABLED: 'false',
        RATE_LIMIT_PER_MINUTE: '120',
        STEPACCESS_USAGE_TIMEOUT_MS: '8000',
      });
      expect(config.engine).toMatchObject({
        maxAttempts: 3,
        breaker: { threshold: 5, openMs: 120_000 },
        streamEnabled: false,
        rateLimitPerMinute: 120,
        stepAccessTimeoutMs: 3000,
        stepAccessUsageTimeoutMs: 8000,
      });
    });

    it.each([
      ['LLM_MAX_ATTEMPTS', '0'],
      ['LLM_MAX_ATTEMPTS', '6'],
      ['LLM_BREAKER_THRESHOLD', '0'],
      ['LLM_BREAKER_OPEN_MS', '10'],
      ['RATE_LIMIT_PER_MINUTE', '-1'],
      ['STEPACCESS_USAGE_TIMEOUT_MS', '5'],
      ['STEPACCESS_USAGE_TIMEOUT_MS', '60001'],
      ['STEPACCESS_TIMEOUT_MS', '30001'],
    ])('recusa %s=%s', (key, value) => {
      expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
    });
  });
});
