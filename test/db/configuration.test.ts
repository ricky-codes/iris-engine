import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, TEST_DATABASE_URL, createTestDb, sqlState, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('configuração', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /** Cada teste usa uma ferramenta nova, porque só há um prompt por ferramenta. */
  async function promptForNewTool(): Promise<number> {
    const tool = await db.pool.query<{ tool_id: number }>(
      `INSERT INTO tool (code) VALUES ('t_' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop')) RETURNING tool_id`,
    );
    const { rows } = await db.pool.query<{ prompt_id: number }>(
      'INSERT INTO prompt (tool_id) VALUES ($1) RETURNING prompt_id',
      [tool.rows[0]!.tool_id],
    );
    return rows[0]!.prompt_id;
  }

  it('só há um prompt por ferramenta', async () => {
    await db.pool.query('INSERT INTO prompt (tool_id) VALUES (1)');
    const code = await sqlState(db.pool.query('INSERT INTO prompt (tool_id) VALUES (1)'));
    expect(code).toBe(SQLSTATE.uniqueViolation);
  });

  it('no máximo uma versão ativa por prompt', async () => {
    const prompt = await promptForNewTool();
    await db.pool.query(
      `INSERT INTO prompt_version (prompt_id, version, system_template, is_active) VALUES ($1, 1, 'a', true)`,
      [prompt],
    );
    const code = await sqlState(
      db.pool.query(
        `INSERT INTO prompt_version (prompt_id, version, system_template, is_active) VALUES ($1, 2, 'b', true)`,
        [prompt],
      ),
    );
    expect(code).toBe(SQLSTATE.uniqueViolation);
  });

  it('trocar a versão ativa numa transação funciona', async () => {
    const prompt = await promptForNewTool();
    await db.pool.query(
      `INSERT INTO prompt_version (prompt_id, version, system_template, is_active)
       VALUES ($1, 1, 'a', true), ($1, 2, 'b', false)`,
      [prompt],
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE prompt_version SET is_active = false WHERE prompt_id = $1 AND version = 1',
        [prompt],
      );
      await client.query(
        'UPDATE prompt_version SET is_active = true WHERE prompt_id = $1 AND version = 2',
        [prompt],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query<{ version: number }>(
      'SELECT version FROM prompt_version WHERE prompt_id = $1 AND is_active',
      [prompt],
    );
    expect(rows).toEqual([{ version: 2 }]);
  });

  it('o texto de uma versão publicada nunca muda', async () => {
    const prompt = await promptForNewTool();
    const { rows } = await db.pool.query<{ prompt_version_id: number }>(
      `INSERT INTO prompt_version (prompt_id, version, system_template) VALUES ($1, 1, 'original')
       RETURNING prompt_version_id`,
      [prompt],
    );
    const id = rows[0]!.prompt_version_id;

    const code = await sqlState(
      db.pool.query(
        `UPDATE prompt_version SET system_template = 'alterado' WHERE prompt_version_id = $1`,
        [id],
      ),
    );
    expect(code).toBe(SQLSTATE.checkViolation);

    // Ativar e anotar continua a ser possível.
    await db.pool.query(
      `UPDATE prompt_version SET is_active = true, change_note = 'ok' WHERE prompt_version_id = $1`,
      [id],
    );
  });

  it('a configuração por ferramenta exige temperatura entre 0 e 2', async () => {
    const model = await db.pool.query<{ llm_model_id: number }>(
      `INSERT INTO llm_model (ai_provider_id, code) VALUES (1, 'modelo-teste') RETURNING llm_model_id`,
    );
    const modelId = model.rows[0]!.llm_model_id;
    const bad = await sqlState(
      db.pool.query(
        `INSERT INTO tool_config (tool_id, llm_model_id, temperature, max_output_tokens, timeout_ms)
         VALUES (1, $1, 2.5, 800, 15000)`,
        [modelId],
      ),
    );
    expect(bad).toBe(SQLSTATE.checkViolation);
    await db.pool.query(
      `INSERT INTO tool_config (tool_id, llm_model_id, temperature, max_output_tokens, timeout_ms)
       VALUES (1, $1, 0.1, 800, 15000)`,
      [modelId],
    );
  });
});
