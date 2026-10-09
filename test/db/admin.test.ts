import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminApi } from '../../src/admin/api.js';
import {
  AdminError,
  createApiKey,
  createOrg,
  createOrgUser,
  createTenant,
  deleteOrgUser,
  previewUserDeletion,
  revokeApiKey,
  setOrgActive,
  setTenantActive,
} from '../../src/admin/commands.js';
import { buildTree, listOrgs, listTenants, listUsers } from '../../src/admin/queries.js';
import { PgCredentialStore } from '../../src/auth/credential-store.js';
import { ensureOrgUser } from '../../src/auth/org-user.js';
import { buildTestApp } from '../helpers.js';
import { TEST_DATABASE_URL, createTestDb, sfId, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('administração', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function newOrg(isSandbox = false) {
    const slug = `c-${randomBytes(3).toString('hex')}`;
    const sfOrgRef = sfId('00D');
    await createTenant(db.pool, { slug, name: `Cliente ${slug}` });
    const { sfOrgId } = await createOrg(db.pool, {
      tenantSlug: slug,
      sfOrgRef,
      instanceUrl: 'https://x.my.salesforce.com',
      isSandbox,
    });
    return { slug, sfOrgRef, sfOrgId };
  }

  describe('validação antes da base de dados', () => {
    it('recusa um identificador de cliente inválido com mensagem clara', async () => {
      await expect(createTenant(db.pool, { slug: 'Pingo Doce', name: 'x' })).rejects.toThrow(
        /slug: .*minúsculas/,
      );
      await expect(createTenant(db.pool, { slug: 'ok-slug', name: '  ' })).rejects.toThrow(/nome/);
    });

    it('recusa ids e URL de org inválidos', async () => {
      const t = await newOrg();
      await expect(
        createOrg(db.pool, {
          tenantSlug: t.slug,
          sfOrgRef: 'x',
          instanceUrl: 'https://a.com',
          isSandbox: false,
        }),
      ).rejects.toThrow(/org-id/);
      await expect(
        createOrg(db.pool, {
          tenantSlug: t.slug,
          sfOrgRef: sfId('00D'),
          instanceUrl: 'http://a.com',
          isSandbox: false,
        }),
      ).rejects.toThrow(/instance-url/);
    });
  });

  describe('utilizadores', () => {
    it('cria um utilizador antes do primeiro pedido, e o primeiro pedido reutiliza-o', async () => {
      const org = await newOrg();
      const ref = sfId('005');
      const { orgUserId } = await createOrgUser(db.pool, {
        sfOrgRef: org.sfOrgRef,
        sfUserRef: ref,
      });
      expect(await ensureOrgUser(db.pool, org.sfOrgId, ref)).toBe(orgUserId);
    });

    it('recusa duplicados, org inexistente e ids inválidos', async () => {
      const org = await newOrg();
      const ref = sfId('005');
      await createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: ref });
      await expect(
        createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: ref }),
      ).rejects.toThrow(/já existe/);
      await expect(
        createOrgUser(db.pool, { sfOrgRef: sfId('00D'), sfUserRef: sfId('005') }),
      ).rejects.toThrow(/não existe/);
      await expect(
        createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: '500xxx' }),
      ).rejects.toBeInstanceOf(AdminError);
    });

    it('mostra o que desaparece e apaga tudo do utilizador, só dele', async () => {
      const org = await newOrg();
      const gone = await createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: sfId('005') });
      const kept = await createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: sfId('005') });

      for (const id of [gone.orgUserId, gone.orgUserId, kept.orgUserId]) {
        await db.pool.query(
          `INSERT INTO inference_request (org_user_id, action_id, request_status_id, sf_record_id, payload_sha256, payload_bytes, received_at)
           VALUES ($1, 1, 3, $2, $3, 10, now())`,
          [id, sfId('500'), randomBytes(32)],
        );
      }
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const m = await client.query<{ memory_id: string }>(
          `INSERT INTO memory (memory_scope_id, memory_kind_id, content) VALUES (3, 1, 'x') RETURNING memory_id`,
        );
        await client.query('INSERT INTO org_user_memory (memory_id, org_user_id) VALUES ($1, $2)', [
          m.rows[0]?.memory_id,
          gone.orgUserId,
        ]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      expect(await previewUserDeletion(db.pool, { orgUserId: gone.orgUserId })).toEqual({
        requests: 2,
        memories: 1,
      });
      expect(await previewUserDeletion(db.pool, { orgUserId: kept.orgUserId })).toEqual({
        requests: 1,
        memories: 0,
      });

      await deleteOrgUser(db.pool, { orgUserId: gone.orgUserId });

      expect(await previewUserDeletion(db.pool, { orgUserId: gone.orgUserId })).toEqual({
        requests: 0,
        memories: 0,
      });
      expect(await previewUserDeletion(db.pool, { orgUserId: kept.orgUserId })).toEqual({
        requests: 1,
        memories: 0,
      });
      await expect(deleteOrgUser(db.pool, { orgUserId: gone.orgUserId })).rejects.toThrow(
        /já não existe/,
      );
    });
  });

  describe('ativar e desativar', () => {
    it('um cliente desativado recusa as chaves das suas orgs, e volta a aceitá-las', async () => {
      const org = await newOrg();
      const { key } = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
      const app = await buildTestApp({ credentialStore: new PgCredentialStore(db.pool) });
      const call = () =>
        app.inject({
          method: 'GET',
          url: '/v1/whoami',
          headers: { authorization: `Bearer ${key}` },
        });
      try {
        expect((await call()).statusCode).toBe(200);
        await setTenantActive(db.pool, { slug: org.slug, isActive: false });
        expect((await call()).statusCode).toBe(401);
        await setTenantActive(db.pool, { slug: org.slug, isActive: true });
        expect((await call()).statusCode).toBe(200);

        await setOrgActive(db.pool, { sfOrgRef: org.sfOrgRef, isActive: false });
        expect((await call()).statusCode).toBe(401);
        await setOrgActive(db.pool, { sfOrgRef: org.sfOrgRef, isActive: true });
        expect((await call()).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('recusa clientes e orgs que não existem', async () => {
      await expect(
        setTenantActive(db.pool, { slug: 'nao-existe', isActive: false }),
      ).rejects.toThrow(/não existe/);
      await expect(
        setOrgActive(db.pool, { sfOrgRef: sfId('00D'), isActive: false }),
      ).rejects.toThrow(/não existe/);
    });
  });

  describe('consultas', () => {
    it('contam orgs, utilizadores, pedidos e memórias', async () => {
      const org = await newOrg(true);
      const user = await createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: sfId('005') });
      await db.pool.query(
        `INSERT INTO inference_request (org_user_id, action_id, request_status_id, sf_record_id, payload_sha256, payload_bytes, received_at)
         VALUES ($1, 1, 3, $2, $3, 10, now())`,
        [user.orgUserId, sfId('500'), randomBytes(32)],
      );

      const tenant = (await listTenants(db.pool)).find((t) => t.slug === org.slug);
      expect(tenant).toMatchObject({ orgCount: 1, isActive: true, retentionDays: 30 });

      const o = (await listOrgs(db.pool)).find((x) => x.sfOrgRef === org.sfOrgRef);
      expect(o).toMatchObject({ userCount: 1, isSandbox: true, tenantSlug: org.slug });

      const u = (await listUsers(db.pool)).find((x) => x.orgUserId === user.orgUserId);
      expect(u).toMatchObject({ requestCount: 1, memoryCount: 0, sfOrgRef: org.sfOrgRef });
    });

    it('a API de administração carrega tudo e a árvore liga as peças', async () => {
      const org = await newOrg();
      const user = await createOrgUser(db.pool, { sfOrgRef: org.sfOrgRef, sfUserRef: sfId('005') });
      const key = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });

      const api = createAdminApi(db.pool);
      const data = await api.load();
      const node = buildTree(data).find((n) => n.tenant.slug === org.slug);

      expect(node?.orgs).toHaveLength(1);
      expect(node?.orgs[0]?.users.map((x) => x.orgUserId)).toEqual([user.orgUserId]);
      expect(node?.orgs[0]?.keys.map((k) => k.keyPrefix)).toEqual([key.keyPrefix]);
      expect(JSON.stringify(data)).not.toContain(key.key);
    });

    it('revogar pela API falha com mensagem clara se a chave já estava revogada', async () => {
      const org = await newOrg();
      const key = await createApiKey(db.pool, { sfOrgRef: org.sfOrgRef });
      const api = createAdminApi(db.pool);
      await api.revokeApiKey(key.keyPrefix);
      await expect(api.revokeApiKey(key.keyPrefix)).rejects.toThrow(/já estava revogada/);
      expect(await revokeApiKey(db.pool, { keyPrefix: key.keyPrefix })).toBe(false);
    });
  });
});
