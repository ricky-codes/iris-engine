import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  TEST_DATABASE_URL,
  addMemory,
  createTestDb,
  sfId,
  sqlState,
  type TestDb,
} from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('memórias', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const count = async (table: string, id: string): Promise<number> => {
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE memory_id = $1`,
      [id],
    );
    return rows[0]!.n;
  };

  it('uma memória pode ser de uma org ou de um utilizador, sem tabelas de identidade', async () => {
    const org = sfId('00D');
    const a = await addMemory(db.pool, { org });
    const b = await addMemory(db.pool, { org, user: sfId('005') });
    expect(await count('org_memory', a)).toBe(1);
    expect(await count('user_memory', b)).toBe(1);
  });

  it('não aceita uma memória sem dono', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memory (memory_scope_id, memory_source_id, content) VALUES (3, 1, 'sem dono')`,
      );
      const code = await sqlState(client.query('COMMIT'));
      expect(code).toBe(SQLSTATE.integrityConstraintViolation);
    } finally {
      client.release();
    }
  });

  it('não liga uma memória de utilizador a uma org (âmbitos não se misturam)', async () => {
    const id = await addMemory(db.pool, { org: sfId('00D'), user: sfId('005') });
    const code = await sqlState(
      db.pool.query('INSERT INTO org_memory (memory_id, sf_org_ref) VALUES ($1, $2)', [
        id,
        sfId('00D'),
      ]),
    );
    expect(code).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('uma memória da org só pode ter origem admin', async () => {
    const code = await sqlState(
      db.pool.query(
        `INSERT INTO memory (memory_scope_id, memory_source_id, content) VALUES (2, 1, 'x')`,
      ),
    );
    expect(code).toBe(SQLSTATE.checkViolation);
  });

  it('recusa ids Salesforce com formato errado', async () => {
    const bad = await sqlState(addMemory(db.pool, { org: '00Dcurto' }));
    const badUser = await sqlState(addMemory(db.pool, { org: sfId('00D'), user: sfId('500') }));
    expect(bad).toBe(SQLSTATE.checkViolation);
    expect(badUser).toBe(SQLSTATE.checkViolation);
  });

  it('recusa texto vazio ou com mais de 500 caracteres', async () => {
    const org = sfId('00D');
    expect(await sqlState(addMemory(db.pool, { org }, '   '))).toBe(SQLSTATE.checkViolation);
    expect(await sqlState(addMemory(db.pool, { org }, 'x'.repeat(501)))).toBe(
      SQLSTATE.checkViolation,
    );
    await addMemory(db.pool, { org }, 'x'.repeat(500));
  });

  it('no máximo 20 memórias por utilizador', async () => {
    const owner = { org: sfId('00D'), user: sfId('005') };
    for (let i = 0; i < 20; i++) await addMemory(db.pool, owner, `m${String(i)}`);
    await expect(addMemory(db.pool, owner, 'a mais')).rejects.toThrow(/memory_limit/);
    // Outro utilizador da mesma org não é afetado.
    await addMemory(db.pool, { org: owner.org, user: sfId('005') });
  });

  it('no máximo 50 memórias por org, mesmo em inserções simultâneas', async () => {
    const org = sfId('00D');
    for (let i = 0; i < 45; i++) await addMemory(db.pool, { org }, `m${String(i)}`);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => addMemory(db.pool, { org }, `p${String(i)}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM org_memory WHERE sf_org_ref = $1',
      [org],
    );
    expect(rows[0]!.n).toBe(50);
  });

  it('apagar a ligação ao dono apaga a memória, e vice-versa', async () => {
    const org = sfId('00D');
    const a = await addMemory(db.pool, { org });
    await db.pool.query('DELETE FROM org_memory WHERE memory_id = $1', [a]);
    expect(await count('memory', a)).toBe(0);

    const b = await addMemory(db.pool, { org, user: sfId('005') });
    await db.pool.query('DELETE FROM memory WHERE memory_id = $1', [b]);
    expect(await count('user_memory', b)).toBe(0);
  });

  it('a restrição por ferramenta é opcional e aceita várias ferramentas', async () => {
    const id = await addMemory(db.pool, { org: sfId('00D') });
    await db.pool.query(
      `INSERT INTO memory_tool (memory_id, tool_id)
       SELECT $1, tool_id FROM tool WHERE code IN ('reply', 'sentiment')`,
      [id],
    );
    expect(await count('memory_tool', id)).toBe(2);
    await db.pool.query('DELETE FROM memory WHERE memory_id = $1', [id]);
    expect(await count('memory_tool', id)).toBe(0);
  });
});
