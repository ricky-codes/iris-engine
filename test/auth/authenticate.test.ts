import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateApiKey } from '../../src/auth/api-key.js';
import { assertOrgMatches, type AuthContext } from '../../src/auth/authenticate.js';
import type { CredentialRecord, CredentialStore } from '../../src/auth/credential-store.js';
import { AppError, type ErrorBody } from '../../src/http/errors.js';
import { buildTestApp } from '../helpers.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const ORG_REF = '00DgL00000O7vLVUAZ';

/** Uma credencial válida, com possibilidade de alterar campos para cada cenário. */
function setup(
  overrides: Partial<Omit<CredentialRecord, 'org' | 'tenant'>> & {
    org?: Partial<CredentialRecord['org']>;
    tenant?: Partial<CredentialRecord['tenant']>;
  } = {},
) {
  const generated = generateApiKey();
  const { org, tenant, ...rest } = overrides;
  const record: CredentialRecord = {
    apiCredentialId: 'cred-1',
    keyPrefix: generated.prefix,
    secretHash: generated.secretHash,
    expiresAt: null,
    revokedAt: null,
    org: { sfOrgId: 'org-1', sfOrgRef: ORG_REF, isSandbox: true, isActive: true, ...org },
    tenant: { tenantId: 'tenant-1', slug: 'iris-dev', name: 'IRIS Dev', isActive: true, ...tenant },
    ...rest,
  };
  const store: CredentialStore = {
    findByPrefix: async (prefix) => (prefix === record.keyPrefix ? record : undefined),
  };
  return { key: generated.key, store };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const call = (headers?: Record<string, string>) =>
  app!.inject({ method: 'GET', url: '/v1/whoami', ...(headers && { headers }) });

describe('autenticação por chave', () => {
  it('aceita uma chave válida e diz a que cliente e org pertence', async () => {
    const { key, store } = setup();
    app = await buildTestApp({ credentialStore: store, clock: () => NOW });
    const res = await call({ authorization: `Bearer ${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tenant: { slug: 'iris-dev', name: 'IRIS Dev' },
      org: { orgId: ORG_REF, isSandbox: true },
    });
  });

  it('aceita "bearer" em minúsculas', async () => {
    const { key, store } = setup();
    app = await buildTestApp({ credentialStore: store, clock: () => NOW });
    expect((await call({ authorization: `bearer ${key}` })).statusCode).toBe(200);
  });

  describe('recusa com 401 e a mesma resposta em todos os casos', () => {
    const scenarios: [string, () => { header?: string; store: CredentialStore }][] = [
      ['sem cabeçalho', () => ({ store: setup().store })],
      ['esquema Basic', () => ({ header: 'Basic abc', store: setup().store })],
      [
        'chave mal formada',
        () => ({ header: 'Bearer isto-nao-e-uma-chave', store: setup().store }),
      ],
      [
        'chave desconhecida',
        () => ({ header: `Bearer ${generateApiKey().key}`, store: setup().store }),
      ],
      [
        'segredo errado com prefixo certo',
        () => {
          const { key, store } = setup();
          const wrong = key.slice(0, 14) + 'A'.repeat(43);
          return { header: `Bearer ${wrong}`, store };
        },
      ],
      [
        'chave revogada',
        () => {
          const { key, store } = setup({ revokedAt: new Date('2026-10-01T00:00:00Z') });
          return { header: `Bearer ${key}`, store };
        },
      ],
      [
        'chave expirada',
        () => {
          const { key, store } = setup({ expiresAt: new Date('2026-10-01T00:00:00Z') });
          return { header: `Bearer ${key}`, store };
        },
      ],
      [
        'org desativada',
        () => {
          const { key, store } = setup({ org: { isActive: false } });
          return { header: `Bearer ${key}`, store };
        },
      ],
      [
        'cliente desativado',
        () => {
          const { key, store } = setup({ tenant: { isActive: false } });
          return { header: `Bearer ${key}`, store };
        },
      ],
    ];

    it.each(scenarios)('%s', async (_label, build) => {
      const { header, store } = build();
      app = await buildTestApp({ credentialStore: store, clock: () => NOW });
      const res = await call(header === undefined ? undefined : { authorization: header });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="iris"');
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message).toBe('Credencial em falta ou inválida.');
    });
  });

  it('uma chave revogada no futuro ainda vale até lá', async () => {
    const { key, store } = setup({ revokedAt: new Date('2026-12-01T00:00:00Z') });
    app = await buildTestApp({ credentialStore: store, clock: () => NOW });
    expect((await call({ authorization: `Bearer ${key}` })).statusCode).toBe(200);
  });

  it('uma chave com expiração futura vale até lá', async () => {
    const { key, store } = setup({ expiresAt: new Date('2026-12-01T00:00:00Z') });
    app = await buildTestApp({ credentialStore: store, clock: () => NOW });
    expect((await call({ authorization: `Bearer ${key}` })).statusCode).toBe(200);
  });

  it('devolve 503 (e não 401) quando a base de dados falha', async () => {
    const store: CredentialStore = {
      findByPrefix: async () => {
        throw new Error('ligação recusada');
      },
    };
    app = await buildTestApp({ credentialStore: store });
    const res = await call({ authorization: `Bearer ${generateApiKey().key}` });
    expect(res.statusCode).toBe(503);
    expect(res.json<ErrorBody>().error.code).toBe('service_unavailable');
    expect(res.body).not.toContain('ligação recusada');
  });

  it('recusa antes de ler o corpo: um pedido sem chave nunca chega à validação', async () => {
    const { store } = setup();
    app = await buildTestApp({ credentialStore: store });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/whoami',
      payload: { lixo: true },
    });
    // Não há POST /v1/whoami; o importante é que nada autenticado fica acessível sem chave.
    expect([401, 404]).toContain(res.statusCode);
    const get = await call();
    expect(get.statusCode).toBe(401);
  });

  it('sem armazém de credenciais não existem rotas /v1', async () => {
    app = await buildTestApp();
    const res = await call({ authorization: `Bearer ${generateApiKey().key}` });
    expect(res.statusCode).toBe(404);
  });

  it('a chave nunca aparece nos logs, nem na recusa nem no sucesso', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const { key, store } = setup();
    app = await buildTestApp({
      credentialStore: store,
      clock: () => NOW,
      logStream,
      env: { LOG_LEVEL: 'trace' },
    });

    const secret = key.split('_').slice(2).join('_');
    await call({ authorization: `Bearer ${key}` });
    await call({ authorization: `Bearer ${key.slice(0, 14)}${'A'.repeat(43)}` });

    const logs = lines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(key);
  });
});

describe('assertOrgMatches', () => {
  const auth: AuthContext = {
    apiCredentialId: 'c',
    tenant: { tenantId: 't', slug: 's', name: 'n', isActive: true },
    org: { sfOrgId: 'o', sfOrgRef: ORG_REF, isSandbox: false, isActive: true },
  };

  it('aceita o id de 18 caracteres da própria org', () => {
    expect(() => {
      assertOrgMatches(auth, ORG_REF);
    }).not.toThrow();
  });

  it('aceita o id de 15 caracteres da própria org', () => {
    expect(() => {
      assertOrgMatches(auth, ORG_REF.slice(0, 15));
    }).not.toThrow();
  });

  it.each([
    ['outra org', '00DgL00000XXXXXXXX'],
    ['vazio', ''],
    ['16 caracteres', ORG_REF.slice(0, 16)],
    ['maiúsculas trocadas', ORG_REF.toUpperCase()],
  ])('recusa com 403 (%s)', (_label, orgId) => {
    try {
      assertOrgMatches(auth, orgId);
      expect.unreachable('devia ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).httpStatus).toBe(403);
      expect((err as AppError).code).toBe('forbidden');
    }
  });
});
