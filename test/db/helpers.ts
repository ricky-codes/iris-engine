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

/** Inserções mínimas, devolvendo os ids. */
export async function seedTenant(
  pool: pg.Pool,
  slug = `t-${randomBytes(3).toString('hex')}`,
): Promise<{ tenantId: string; orgId: string; userId: string }> {
  const tenant = await pool.query<{ tenant_id: string }>(
    `INSERT INTO tenant (slug, name) VALUES ($1, $1) RETURNING tenant_id`,
    [slug],
  );
  const tenantId = tenant.rows[0]!.tenant_id;
  const org = await pool.query<{ sf_org_id: string }>(
    `INSERT INTO sf_org (tenant_id, sf_org_ref, instance_url, is_sandbox)
     VALUES ($1, $2, 'https://example.my.salesforce.com', true) RETURNING sf_org_id`,
    [tenantId, sfId('00D')],
  );
  const orgId = org.rows[0]!.sf_org_id;
  const user = await pool.query<{ org_user_id: string }>(
    `INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2) RETURNING org_user_id`,
    [orgId, sfId('005')],
  );
  return { tenantId, orgId, userId: user.rows[0]!.org_user_id };
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
