import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Gera um id Salesforce de 18 caracteres com o prefixo dado ('00D', '005', '500'...). */
export function sfId(prefix: string): string {
  const body = randomBytes(12).toString('hex').slice(0, 15);
  return prefix + body;
}

export interface TestDb {
  pool: pg.Pool;
  schema: string;
  close: () => Promise<void>;
}

/** Um schema novo por teste: isolado, e apagado no fim. */
export async function createTestDb(): Promise<TestDb> {
  if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL não definido');

  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, MIGRATIONS_DIR);

  return {
    pool,
    schema,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Insere uma memória e a ligação ao dono na mesma transação. Devolve o id. */
export async function addMemory(
  pool: pg.Pool,
  owner: { org: string; user?: string },
  content = 'Tratar sempre o cliente por você.',
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Âmbito 2 = org (origem admin), 3 = utilizador (origem utilizador).
    const scope = owner.user === undefined ? 2 : 3;
    const source = owner.user === undefined ? 2 : 1;
    const { rows } = await client.query<{ memory_id: string }>(
      `INSERT INTO memory (memory_scope_id, memory_source_id, content) VALUES ($1, $2, $3)
       RETURNING memory_id`,
      [scope, source, content],
    );
    const id = rows[0]!.memory_id;
    if (owner.user === undefined) {
      await client.query('INSERT INTO org_memory (memory_id, sf_org_ref) VALUES ($1, $2)', [
        id,
        owner.org,
      ]);
    } else {
      await client.query(
        'INSERT INTO user_memory (memory_id, sf_org_ref, sf_user_ref) VALUES ($1, $2, $3)',
        [id, owner.org, owner.user],
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Códigos SQLSTATE usados nas asserções. */
export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  integrityConstraintViolation: '23000',
} as const;

/** Devolve o SQLSTATE do erro que a promessa lança (ou undefined se não lançar). */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}
