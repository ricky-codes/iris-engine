import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminError,
  MAX_ACTIVE_KEYS_PER_ORG,
  createApiKey,
  createOrg,
  createTenant,
  listKeys,
  revokeApiKey,
} from '../../src/admin/commands.js';
import { PgCredentialStore } from '../../src/auth/credential-store.js';
import { ensureOrgUser } from '../../src/auth/org-user.js';
import { ERROR_CODES } from '../../src/http/errors.js';
import { buildTestApp } from '../helpers.js';
import { TEST_DATABASE_URL, createTestDb, sfId, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('autenticação com base de dados', () => {
  let db: TestDb;
  let app: FastifyInstance | undefined;
  let clockNow = new Date();

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Cria cliente + org e devolve o necessário para criar chaves e chamar a API. */
  async function newOrg(isSandbox = true) {
    const slug = `c-${randomBytes(3).toString('hex')}`;
    const sfOrgRef = sfId('00D');
    await createTenant(db.pool, { slug, name: `Cliente ${slug}` });
    const { sfOrgId } = await createOrg(db.pool, {
      tenantSlug: slug,
      sfOrgRef,
      instanceUrl: 'https://exemplo.my.salesforce.com/',
      isSandbox,
    });
    return { slug, sfOrgRef, sfOrgId };
  }

  async function startApp(now: Date = new Date()) {
    clockNow = now;
    app = await buildTestApp({
      credentialStore: new PgCredentialStore(db.pool),
      clock: () => clockNow,
    });
    return app;
  }

  const whoami = (key: string) =>
    app!.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${key}` },
    });

  it('o fluxo completo: cria cliente, org e chave, e a chave identifica a org', async () => {
    const org = await newOrg();
    const { key } = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    await startApp();

    const res = await whoami(key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tenant: { slug: org.slug, name: `Cliente ${org.slug}` },
      org: { orgId: org.sfOrgRef, isSandbox: true },
    });
  });

  it('a chave de uma org não identifica outra', async () => {
    const a = await newOrg();
    const b = await newOrg(false);
    const keyA = await createApiKey(db.pool, { sfOrgRef: a.sfOrgRef });
    const keyB = await createApiKey(db.pool, { sfOrgRef: b.sfOrgRef });
    await startApp();

    expect((await whoami(keyA.key)).json<{ org: { orgId: string } }>().org.orgId).toBe(a.sfOrgRef);
    const resB = await whoami(keyB.key);
    expect(resB.json<{ org: { orgId: string; isSandbox: boolean } }>().org).toEqual({
      orgId: b.sfOrgRef,
      isSandbox: false,
    });
  });

  it('a base de dados só guarda o hash, nunca a chave', async () => {
    const org = await newOrg();
    const { key, keyPrefix } = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    const secret = key.split('_').slice(2).join('_');

    const { rows } = await db.pool.query<{ secret_hash: Buffer; key_prefix: string }>(
      'SELECT secret_hash, key_prefix FROM api_credential WHERE key_prefix = $1',
      [keyPrefix],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secret_hash).toHaveLength(32);

    const everything = await db.pool.query<{ t: string }>(
      `SELECT row_to_json(c)::text AS t FROM api_credential c WHERE key_prefix = $1`,
      [keyPrefix],
    );
    expect(everything.rows[0]!.t).not.toContain(secret);
  });

  it('revogar uma chave recusa-a de imediato', async () => {
    const org = await newOrg();
    const { key, keyPrefix } = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    await startApp();
    expect((await whoami(key)).statusCode).toBe(200);

    expect(await revokeApiKey(db.pool, { keyPrefix })).toBe(true);
    clockNow = new Date(Date.now() + 1_000);
    expect((await whoami(key)).statusCode).toBe(401);
    expect(await revokeApiKey(db.pool, { keyPrefix })).toBe(false);
  });

  it('uma chave com validade expira na data', async () => {
    const org = await newOrg();
    const created = new Date('2026-10-08T12:00:00Z');
    const { key } = await createApiKey(db.pool, {
      sfOrgRef: org.sfOrgRef,
      expiresInDays: 30,
      now: created,
    });

    await startApp(new Date('2026-11-01T00:00:00Z'));
    expect((await whoami(key)).statusCode).toBe(200);
    clockNow = new Date('2026-11-07T12:00:00Z');
    expect((await whoami(key)).statusCode).toBe(401);
  });

  it('rodar a chave: a nova e a antiga coexistem até se revogar a antiga', async () => {
    const org = await newOrg();
    const oldKey = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    const newKey = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    await startApp();
    expect((await whoami(oldKey.key)).statusCode).toBe(200);
    expect((await whoami(newKey.key)).statusCode).toBe(200);

    await revokeApiKey(db.pool, { keyPrefix: oldKey.keyPrefix });
    clockNow = new Date(Date.now() + 1_000);
    expect((await whoami(oldKey.key)).statusCode).toBe(401);
    expect((await whoami(newKey.key)).statusCode).toBe(200);
  });

  it(`recusa uma terceira chave ativa (máximo ${MAX_ACTIVE_KEYS_PER_ORG})`, async () => {
    const org = await newOrg();
    await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    const second = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    await expect(createApiKey(db.pool, { sfOrgRef: org.sfOrgRef })).rejects.toBeInstanceOf(
      AdminError,
    );

    await revokeApiKey(db.pool, { keyPrefix: second.keyPrefix });
    await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
  });

  it('duas criações em simultâneo não furam o limite de chaves ativas', async () => {
    const org = await newOrg();
    await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    const results = await Promise.allSettled([
      createApiKey(db.pool, { sfOrgRef: org.sfOrgRef }),
      createApiKey(db.pool, { sfOrgRef: org.sfOrgRef }),
      createApiKey(db.pool, { sfOrgRef: org.sfOrgRef }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await db.pool.query(
      'SELECT 1 FROM api_credential WHERE sf_org_id = $1 AND revoked_at IS NULL',
      [org.sfOrgId],
    );
    expect(rows).toHaveLength(MAX_ACTIVE_KEYS_PER_ORG);
  });

  it('desativar a org ou o cliente recusa as chaves', async () => {
    const org = await newOrg();
    const { key } = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
    await startApp();
    expect((await whoami(key)).statusCode).toBe(200);

    await db.pool.query('UPDATE sf_org SET is_active = false WHERE sf_org_id = $1', [org.sfOrgId]);
    expect((await whoami(key)).statusCode).toBe(401);

    await db.pool.query('UPDATE sf_org SET is_active = true WHERE sf_org_id = $1', [org.sfOrgId]);
    expect((await whoami(key)).statusCode).toBe(200);

    await db.pool.query('UPDATE tenant SET is_active = false WHERE slug = $1', [org.slug]);
    expect((await whoami(key)).statusCode).toBe(401);
  });

  describe('comandos de administração', () => {
    it('recusam duplicados com mensagens claras', async () => {
      const org = await newOrg();
      await expect(createTenant(db.pool, { slug: org.slug, name: 'x' })).rejects.toThrow(
        /Já existe/,
      );
      await expect(
        createOrg(db.pool, {
          tenantSlug: org.slug,
          sfOrgRef: org.sfOrgRef,
          instanceUrl: 'https://x.my.salesforce.com',
          isSandbox: false,
        }),
      ).rejects.toThrow(/já está registada/);
      await expect(
        createOrg(db.pool, {
          tenantSlug: 'nao-existe',
          sfOrgRef: sfId('00D'),
          instanceUrl: 'https://x.my.salesforce.com',
          isSandbox: false,
        }),
      ).rejects.toThrow(/não existe/);
      await expect(createApiKey(db.pool, { sfOrgRef: sfId('00D') })).rejects.toThrow(/não existe/);
    });

    it('retira a barra final do URL da org', async () => {
      const org = await newOrg();
      const { rows } = await db.pool.query<{ instance_url: string }>(
        'SELECT instance_url FROM sf_org WHERE sf_org_id = $1',
        [org.sfOrgId],
      );
      expect(rows[0]?.instance_url).toBe('https://exemplo.my.salesforce.com');
    });

    it('listam as chaves sem segredos e com o estado certo', async () => {
      const org = await newOrg();
      const active = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
      const toRevoke = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
      await revokeApiKey(db.pool, { keyPrefix: toRevoke.keyPrefix });

      const list = (await listKeys(db.pool, new Date(Date.now() + 1_000))).filter(
        (k) => k.org === org.sfOrgRef,
      );
      expect(list.map((k) => [k.keyPrefix, k.status])).toEqual([
        [active.keyPrefix, 'ativa'],
        [toRevoke.keyPrefix, 'revogada'],
      ]);
      expect(JSON.stringify(list)).not.toContain('iris_');
    });
  });

  describe('utilizadores', () => {
    it('cria o utilizador no primeiro pedido e reutiliza-o nos seguintes', async () => {
      const org = await newOrg();
      const ref = sfId('005');
      const first = await ensureOrgUser(db.pool, org.sfOrgId, ref);
      const second = await ensureOrgUser(db.pool, org.sfOrgId, ref);
      expect(second).toBe(first);
      const { rows } = await db.pool.query('SELECT 1 FROM org_user WHERE sf_org_id = $1', [
        org.sfOrgId,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('o mesmo id em duas orgs dá dois utilizadores', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const ref = sfId('005');
      expect(await ensureOrgUser(db.pool, a.sfOrgId, ref)).not.toBe(
        await ensureOrgUser(db.pool, b.sfOrgId, ref),
      );
    });

    it('pedidos simultâneos do mesmo utilizador novo não duplicam nem falham', async () => {
      const org = await newOrg();
      const ref = sfId('005');
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => ensureOrgUser(db.pool, org.sfOrgId, ref)),
      );
      expect(new Set(ids).size).toBe(1);
    });

    it.each(['', '005', '500gL00001HzOO5QAN', '005gL00000GpOQT', '005gL00000GpOQTQA3X'])(
      'recusa um userId inválido (%j)',
      async (ref) => {
        const org = await newOrg();
        await expect(ensureOrgUser(db.pool, org.sfOrgId, ref)).rejects.toMatchObject({
          httpStatus: 422,
        });
      },
    );
  });

  it('todos os códigos de erro da API existem no catálogo da base de dados', async () => {
    const { rows } = await db.pool.query<{ code: string }>('SELECT code FROM error_type');
    const inDb = new Set(rows.map((r) => r.code));
    for (const code of ERROR_CODES) expect(inDb.has(code), code).toBe(true);
    expect(inDb.size).toBe(ERROR_CODES.length);
  });
});
