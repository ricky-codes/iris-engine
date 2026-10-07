import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

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
