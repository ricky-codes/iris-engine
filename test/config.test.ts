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
        apiSecret: undefined,
        stepAccess: undefined,
        openRouter: undefined,
        defaultModel: 'google/gemini-2.5-flash',
        fallbackModels: [],
        totalTimeoutMs: 30_000,
        enableDiagnosticTool: false,
      },
      alerts: {
        webhook: undefined,
        evalIntervalMs: 60_000,
        windowMs: 900_000,
        repeatMs: 14_400_000,
        consoleUrl: undefined,
      },
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
      timeoutMs: 3000,
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

  it('alertas: webhook com URL e segredo juntos, formato iris ou slack, e intervalos válidos', () => {
    const hook = {
      ALERT_WEBHOOK_URL: 'https://n8n.exemplo.pt/webhook/iris',
      ALERT_WEBHOOK_SECRET: 's'.repeat(32),
    };
    expect(
      loadConfig({ ...hook, ALERT_WEBHOOK_FORMAT: 'slack', CONSOLE_URL: 'https://hub.exemplo.pt/' })
        .alerts,
    ).toMatchObject({
      webhook: { url: hook.ALERT_WEBHOOK_URL, secret: 's'.repeat(32), format: 'slack' },
      consoleUrl: 'https://hub.exemplo.pt',
    });
    expect(loadConfig(hook).alerts.webhook?.format).toBe('iris');
    expect(() => loadConfig({ ALERT_WEBHOOK_URL: hook.ALERT_WEBHOOK_URL })).toThrow(
      /ou os dois ou nenhum/,
    );
    expect(() => loadConfig({ ...hook, ALERT_WEBHOOK_SECRET: 'curto' })).toThrow(
      /ALERT_WEBHOOK_SECRET/,
    );
    expect(() => loadConfig({ ...hook, ALERT_WEBHOOK_URL: 'ftp://x' })).toThrow(
      /ALERT_WEBHOOK_URL/,
    );
    expect(() => loadConfig({ ALERT_WEBHOOK_FORMAT: 'teams' })).toThrow(/ALERT_WEBHOOK_FORMAT/);
    expect(() => loadConfig({ ALERT_EVAL_INTERVAL_MS: '1000' })).toThrow(/ALERT_EVAL_INTERVAL_MS/);
    expect(() => loadConfig({ ALERT_EVAL_INTERVAL_MS: '600000' })).toThrow(/pelo menos o dobro/);
    expect(
      loadConfig({ ALERT_WINDOW_MS: '1800000', ALERT_REPEAT_MS: '3600000' }).alerts,
    ).toMatchObject({
      windowMs: 1_800_000,
      repeatMs: 3_600_000,
    });
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
});
