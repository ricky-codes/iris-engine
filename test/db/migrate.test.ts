import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations } from '../../src/db/migrate.js';
import { MIGRATIONS_DIR, TEST_DATABASE_URL, createTestDb, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('migrações', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('segunda execução não aplica nada', async () => {
    const result = await runMigrations(db.pool, MIGRATIONS_DIR);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(6);
  });

  it('o catálogo de ferramentas vem do código: sem is_implemented e com ids gerados', async () => {
    const tools = await db.pool.query<{ code: string }>('SELECT code FROM tool ORDER BY tool_id');
    expect(tools.rows.map((r) => r.code)).toEqual(['sentiment', 'tipification', 'reply']);
    const created = await db.pool.query<{ tool_id: number }>(
      `INSERT INTO tool (code) VALUES ('remember') RETURNING tool_id`,
    );
    expect(created.rows[0]?.tool_id).toBeGreaterThan(3);
  });

  it('já não existem tabelas de pedidos nem de resultados', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('inference_request', 'llm_call', 'sentiment_result', 'sentiment_signal',
                            'tipification_result', 'tipification_result_value', 'reply_request',
                            'reply_result', 'request_status', 'error_type', 'sentiment_label',
                            'urgency_level', 'message_item_type', 'action')`,
    );
    expect(rows).toEqual([]);
  });

  describe('com ficheiros próprios', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'iris-migrations-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('recusa uma migração já aplicada cujo conteúdo mudou', async () => {
      await writeFile(join(dir, '0001_um.sql'), 'CREATE TABLE tmp_um (id int);');
      // O schema de teste já tem as migrações reais registadas: limpa-se o registo.
      await db.pool.query('DELETE FROM schema_migration');
      await runMigrations(db.pool, dir);

      await writeFile(join(dir, '0001_um.sql'), 'CREATE TABLE tmp_um (id int, extra int);');
      await expect(runMigrations(db.pool, dir)).rejects.toThrow(/conteúdo mudou/);
    });

    it('anula tudo se um ficheiro falhar a meio', async () => {
      await db.pool.query('DELETE FROM schema_migration');
      const bad = await mkdtemp(join(tmpdir(), 'iris-migrations-bad-'));
      try {
        await writeFile(
          join(bad, '0001_falha.sql'),
          'CREATE TABLE tmp_parcial (id int); SELECT * FROM tabela_que_nao_existe;',
        );
        await expect(runMigrations(db.pool, bad)).rejects.toBeInstanceOf(MigrationError);
        const { rows } = await db.pool.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'tmp_parcial'`,
        );
        expect(rows).toHaveLength(0);
      } finally {
        await rm(bad, { recursive: true, force: true });
      }
    });

    it('recusa nomes de ficheiro fora do padrão', async () => {
      const odd = await mkdtemp(join(tmpdir(), 'iris-migrations-odd-'));
      try {
        await writeFile(join(odd, 'sem-numero.sql'), 'SELECT 1;');
        await expect(runMigrations(db.pool, odd)).rejects.toThrow(/inválido/);
      } finally {
        await rm(odd, { recursive: true, force: true });
      }
    });
  });
});
