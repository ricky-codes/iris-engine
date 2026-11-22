import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { consoleCsp, type AdminRoutesOptions } from '../../src/http/routes/admin.js';
import { Metrics } from '../../src/engine/metrics.js';
import { buildTestApp, testSettings } from '../helpers.js';

const SECRET = 'c'.repeat(40);
const unused = async (): Promise<never> => {
  throw new Error('não usado');
};

function admin(over: Partial<AdminRoutesOptions> = {}): AdminRoutesOptions {
  return {
    secret: SECRET,
    pool: {} as Pool,
    tools: [],
    settings: testSettings(),
    breakers: undefined,
    instanceId: 'teste:1',
    metrics: new Metrics(),
    status: unused,
    topology: unused,
    modules: unused,
    models: { list: unused },
    playground: undefined,
    ...over,
  };
}

describe('consola (/v1/admin/console)', () => {
  const html = readFileSync('console/index.html', 'utf8');

  it('serve a página sem segredo, com uma CSP que só deixa correr o script da página', async () => {
    const app = await buildTestApp({ admin: admin({ consoleHtml: html }) });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/console' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toBe(html);
    const csp = String(res.headers['content-security-policy']);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    await app.close();
  });

  it('as outras rotas continuam a exigir o segredo', async () => {
    const app = await buildTestApp({ admin: admin({ consoleHtml: html }) });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/metrics' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(ok.statusCode).toBe(200);
    // Sem StepAccess não há envios do custo.
    expect(ok.json<{ costReports: unknown }>().costReports).toBeNull();
    await app.close();
  });

  it('mostra os envios do custo quando há StepAccess', async () => {
    const stats = {
      delivered: 3,
      failed: 1,
      pending: 0,
      deliveredUsd: 0.01,
      failedUsd: 0.002,
      lastDeliveredAt: null,
      lastFailedAt: null,
      lastFailure: '503',
    };
    const app = await buildTestApp({ admin: admin({ costReports: () => stats }) });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.json<{ costReports: unknown }>().costReports).toEqual(stats);
    await app.close();
  });

  it('404 quando a página não está instalada', async () => {
    const app = await buildTestApp({ admin: admin() });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/console' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('a página não carrega nada de fora nem escreve HTML a partir de dados', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(consoleCsp('<p>sem scripts</p>')).toContain("script-src 'none'");
  });
});
