import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const STEPACCESS = {
  STEPACCESS_URL: 'https://access.example.com',
  STEPACCESS_USER: 'iris',
  STEPACCESS_PASSWORD: 'segredo',
  STEPACCESS_COMPONENT_UUID: '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
};
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  API_SECRET: 'x'.repeat(32),
  OPENROUTER_API_KEY: 'sk-or-teste',
  ...STEPACCESS,
};

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
        enableDiagnosticTool: false,
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
