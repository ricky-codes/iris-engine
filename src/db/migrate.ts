import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Corre ficheiros SQL por ordem de nome (0001_x.sql, 0002_y.sql, ...).
 * - Cada ficheiro corre numa transação: ou aplica tudo ou nada.
 * - Um ficheiro já aplicado nunca volta a correr; se o conteúdo mudou, falha.
 * - Um bloqueio consultivo impede duas instâncias de migrarem ao mesmo tempo.
 */

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 727_274_001;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const names = entries.filter((n) => n.endsWith('.sql')).sort();

  const invalid = names.filter((n) => !MIGRATION_FILE.test(n));
  if (invalid.length > 0) {
    throw new MigrationError(`Nome de migração inválido: ${invalid.join(', ')}`);
  }

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function runMigrations(pool: Pool, dir: string): Promise<MigrationResult> {
  const files = await readMigrationFiles(dir);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       text        PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migration',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const missing = [...applied.keys()].filter((n) => !files.some((f) => f.name === n));
    if (missing.length > 0) {
      throw new MigrationError(`Migrações aplicadas mas ausentes do disco: ${missing.join(', ')}`);
    }

    for (const file of files) {
      const previous = applied.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new MigrationError(
            `A migração ${file.name} já foi aplicada e o conteúdo mudou. Crie uma migração nova.`,
          );
        }
        result.skipped.push(file.name);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new MigrationError(
          `Falhou a migração ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      result.applied.push(file.name);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } finally {
      client.release();
    }
  }

  return result;
}
