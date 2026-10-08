import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  TEST_DATABASE_URL,
  createTestDb,
  seedTenant,
  sqlState,
  type TestDb,
} from './helpers.js';

const SCOPE = { tenant: 1, org: 2, user: 3 } as const;
const KIND = { preference: 1, fact: 2 } as const;

/** Insere uma memória e a ligação ao dono na mesma transação. */
async function addMemory(
  pool: pg.Pool,
  scope: keyof typeof SCOPE,
  ownerId: string,
  content = 'Responder sempre de forma curta.',
): Promise<string> {
  const table = { tenant: 'tenant_memory', org: 'sf_org_memory', user: 'org_user_memory' }[scope];
  const column = { tenant: 'tenant_id', org: 'sf_org_id', user: 'org_user_id' }[scope];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = await client.query<{ memory_id: string }>(
      `INSERT INTO memory (memory_scope_id, memory_kind_id, content)
       VALUES ($1, $2, $3) RETURNING memory_id`,
      [SCOPE[scope], KIND.preference, content],
    );
    const id = m.rows[0]!.memory_id;
    await client.query(`INSERT INTO ${table} (memory_id, ${column}) VALUES ($1, $2)`, [
      id,
      ownerId,
    ]);
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const exists = async (pool: pg.Pool, id: string): Promise<boolean> =>
  (await pool.query('SELECT 1 FROM memory WHERE memory_id = $1', [id])).rowCount === 1;

describe.skipIf(TEST_DATABASE_URL === undefined)('memórias', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('cada âmbito existe sem os outros', async () => {
    const t = await seedTenant(db.pool);
    await addMemory(db.pool, 'user', t.userId);
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*) FROM tenant_memory WHERE tenant_id = $1)::int AS tenant,
              (SELECT count(*) FROM sf_org_memory WHERE sf_org_id = $2)::int AS org,
              (SELECT count(*) FROM org_user_memory WHERE org_user_id = $3)::int AS usr`,
      [t.tenantId, t.orgId, t.userId],
    );
    expect(rows[0]).toEqual({ tenant: 0, org: 0, usr: 1 });
  });

  it('as memórias dos três âmbitos juntam-se por utilizador', async () => {
    const t = await seedTenant(db.pool);
    await addMemory(db.pool, 'tenant', t.tenantId, 'O cliente é uma cadeia de supermercados.');
    await addMemory(db.pool, 'org', t.orgId, 'Tratar sempre por você.');
    await addMemory(db.pool, 'user', t.userId, 'Respostas curtas.');

    const { rows } = await db.pool.query<{ scope: string; content: string }>(
      `SELECT s.code AS scope, m.content
       FROM org_user u
       JOIN sf_org o ON o.sf_org_id = u.sf_org_id
       JOIN memory m ON m.archived_at IS NULL AND m.memory_id IN (
              SELECT memory_id FROM tenant_memory   WHERE tenant_id   = o.tenant_id
        UNION SELECT memory_id FROM sf_org_memory   WHERE sf_org_id   = o.sf_org_id
        UNION SELECT memory_id FROM org_user_memory WHERE org_user_id = u.org_user_id)
       JOIN memory_scope s ON s.memory_scope_id = m.memory_scope_id
       WHERE u.org_user_id = $1
       ORDER BY s.memory_scope_id`,
      [t.userId],
    );
    expect(rows.map((r) => r.scope)).toEqual(['tenant', 'org', 'user']);
  });

  it('não aceita a ligação de uma memória a um dono de outro âmbito', async () => {
    const t = await seedTenant(db.pool);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const m = await client.query<{ memory_id: string }>(
        `INSERT INTO memory (memory_scope_id, memory_kind_id, content)
         VALUES ($1, $2, 'x') RETURNING memory_id`,
        [SCOPE.tenant, KIND.fact],
      );
      // Memória do âmbito "cliente" ligada como se fosse de um utilizador.
      const code = await sqlState(
        client.query('INSERT INTO org_user_memory (memory_id, org_user_id) VALUES ($1, $2)', [
          m.rows[0]!.memory_id,
          t.userId,
        ]),
      );
      expect(code).toBe(SQLSTATE.foreignKeyViolation);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('não aceita o âmbito escrito à mão na tabela de dono', async () => {
    const t = await seedTenant(db.pool);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const m = await client.query<{ memory_id: string }>(
        `INSERT INTO memory (memory_scope_id, memory_kind_id, content)
         VALUES ($1, $2, 'x') RETURNING memory_id`,
        [SCOPE.org, KIND.fact],
      );
      const code = await sqlState(
        client.query(
          'INSERT INTO org_user_memory (memory_id, memory_scope_id, org_user_id) VALUES ($1, 2, $2)',
          [m.rows[0]!.memory_id, t.userId],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('uma memória não pode ter dois donos', async () => {
    const a = await seedTenant(db.pool);
    const b = await seedTenant(db.pool);
    const id = await addMemory(db.pool, 'user', a.userId);
    const code = await sqlState(
      db.pool.query('INSERT INTO org_user_memory (memory_id, org_user_id) VALUES ($1, $2)', [
        id,
        b.userId,
      ]),
    );
    expect(code).toBe(SQLSTATE.uniqueViolation);
  });

  it('uma memória sem dono é recusada no commit', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memory (memory_scope_id, memory_kind_id, content) VALUES (1, 2, 'sem dono')`,
      );
      const code = await sqlState(client.query('COMMIT'));
      expect(code).toBe(SQLSTATE.integrityConstraintViolation);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('apagar o utilizador apaga as memórias dele e só essas', async () => {
    const t = await seedTenant(db.pool);
    const mine = await addMemory(db.pool, 'user', t.userId);
    const org = await addMemory(db.pool, 'org', t.orgId);

    await db.pool.query('DELETE FROM org_user WHERE org_user_id = $1', [t.userId]);

    expect(await exists(db.pool, mine)).toBe(false);
    expect(await exists(db.pool, org)).toBe(true);
  });

  it('apagar a memória apaga a ligação ao dono', async () => {
    const t = await seedTenant(db.pool);
    const id = await addMemory(db.pool, 'user', t.userId);
    await db.pool.query('DELETE FROM memory WHERE memory_id = $1', [id]);
    const { rowCount } = await db.pool.query('SELECT 1 FROM org_user_memory WHERE memory_id = $1', [
      id,
    ]);
    expect(rowCount).toBe(0);
  });

  it('o autor passa a nulo quando o autor é apagado, sem perder a memória', async () => {
    const t = await seedTenant(db.pool);
    const author = await db.pool.query<{ org_user_id: string }>(
      `INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, '005AAAAAAAAAAAAAAA') RETURNING org_user_id`,
      [t.orgId],
    );
    const authorId = author.rows[0]!.org_user_id;
    const id = await addMemory(db.pool, 'org', t.orgId, 'Escrita por um administrador.');
    await db.pool.query('UPDATE memory SET created_by = $2 WHERE memory_id = $1', [id, authorId]);

    await db.pool.query('DELETE FROM org_user WHERE org_user_id = $1', [authorId]);

    const { rows } = await db.pool.query<{ created_by: string | null }>(
      'SELECT created_by FROM memory WHERE memory_id = $1',
      [id],
    );
    expect(rows[0]?.created_by).toBeNull();
  });

  it('a restrição por ação é opcional e aceita várias ações', async () => {
    const t = await seedTenant(db.pool);
    const id = await addMemory(db.pool, 'user', t.userId);
    await db.pool.query(
      `INSERT INTO memory_action (memory_id, action_id) VALUES ($1, 3), ($1, 1)`,
      [id],
    );
    const { rows } = await db.pool.query('SELECT 1 FROM memory_action WHERE memory_id = $1', [id]);
    expect(rows).toHaveLength(2);
  });

  it('recusa texto vazio ou demasiado longo', async () => {
    const t = await seedTenant(db.pool);
    expect(await sqlState(addMemory(db.pool, 'user', t.userId, '   '))).toBe(
      SQLSTATE.checkViolation,
    );
    expect(await sqlState(addMemory(db.pool, 'user', t.userId, 'x'.repeat(2001)))).toBe(
      SQLSTATE.checkViolation,
    );
  });
});
