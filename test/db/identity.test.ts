import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  TEST_DATABASE_URL,
  createTestDb,
  seedTenant,
  sfId,
  sqlState,
  type TestDb,
} from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('identidade', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('o mesmo id de utilizador em duas orgs são dois utilizadores', async () => {
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const ref = sfId('005');
    await db.pool.query('INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2)', [
      a.orgId,
      ref,
    ]);
    await db.pool.query('INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2)', [
      b.orgId,
      ref,
    ]);
    const { rows } = await db.pool.query('SELECT 1 FROM org_user WHERE sf_user_ref = $1', [ref]);
    expect(rows).toHaveLength(2);
  });

  it('recusa o mesmo utilizador duas vezes na mesma org', async () => {
    const t = await seedTenant(db.pool);
    const ref = sfId('005');
    await db.pool.query('INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2)', [
      t.orgId,
      ref,
    ]);
    const code = await sqlState(
      db.pool.query('INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2)', [
        t.orgId,
        ref,
      ]),
    );
    expect(code).toBe(SQLSTATE.uniqueViolation);
  });

  it.each([
    ['15 caracteres', '00DgL00000O7vLV'],
    ['prefixo errado', '005gL00000O7vLVUAZ'],
    ['com símbolos', '00DgL00000O7vL_UAZ'],
  ])('recusa id de org inválido (%s)', async (_label, ref) => {
    const t = await seedTenant(db.pool);
    const code = await sqlState(
      db.pool.query(
        `INSERT INTO sf_org (tenant_id, sf_org_ref, instance_url, is_sandbox)
         VALUES ($1, $2, 'https://x.my.salesforce.com', false)`,
        [t.tenantId, ref],
      ),
    );
    expect(code).toBe(SQLSTATE.checkViolation);
  });

  it('aceita o id de org e de utilizador reais do pedido de exemplo', async () => {
    const t = await seedTenant(db.pool);
    const org = await db.pool.query<{ sf_org_id: string }>(
      `INSERT INTO sf_org (tenant_id, sf_org_ref, instance_url, is_sandbox)
       VALUES ($1, '00DgL00000O7vLVUAZ', 'https://orgfarm-9637ae9ebe-dev-ed.develop.my.salesforce.com', true)
       RETURNING sf_org_id`,
      [t.tenantId],
    );
    await db.pool.query(
      `INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, '005gL00000GpOQTQA3')`,
      [org.rows[0]!.sf_org_id],
    );
  });

  it('recusa instance_url sem https', async () => {
    const t = await seedTenant(db.pool);
    const code = await sqlState(
      db.pool.query(
        `INSERT INTO sf_org (tenant_id, sf_org_ref, instance_url, is_sandbox)
         VALUES ($1, $2, 'http://x.my.salesforce.com', false)`,
        [t.tenantId, sfId('00D')],
      ),
    );
    expect(code).toBe(SQLSTATE.checkViolation);
  });

  it('recusa um hash de chave que não tem 32 bytes', async () => {
    const t = await seedTenant(db.pool);
    const code = await sqlState(
      db.pool.query(
        `INSERT INTO api_credential (sf_org_id, key_prefix, secret_hash)
         VALUES ($1, 'abcd1234', '\\x00'::bytea)`,
        [t.orgId],
      ),
    );
    expect(code).toBe(SQLSTATE.checkViolation);
  });

  it('não deixa apagar uma org que ainda tem utilizadores', async () => {
    const t = await seedTenant(db.pool);
    const code = await sqlState(
      db.pool.query('DELETE FROM sf_org WHERE sf_org_id = $1', [t.orgId]),
    );
    expect(code).toBe(SQLSTATE.foreignKeyViolation);
  });
});
