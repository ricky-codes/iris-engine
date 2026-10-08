import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  TEST_DATABASE_URL,
  createTestDb,
  seedTenant,
  sqlState,
  type TestDb,
} from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('configuração', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function promptFor(action: number, tenantId: string | null): Promise<number> {
    const { rows } = await db.pool.query<{ prompt_id: number }>(
      'INSERT INTO prompt (action_id, tenant_id) VALUES ($1, $2) RETURNING prompt_id',
      [action, tenantId],
    );
    return rows[0]!.prompt_id;
  }

  it('só há um prompt por omissão por ação', async () => {
    await promptFor(1, null);
    const code = await sqlState(promptFor(1, null));
    expect(code).toBe(SQLSTATE.uniqueViolation);
  });

  it('um cliente pode ter prompt próprio além do prompt por omissão', async () => {
    const t = await seedTenant(db.pool);
    await promptFor(3, null);
    await promptFor(3, t.tenantId);
  });

  it('no máximo uma versão ativa por prompt', async () => {
    const t = await seedTenant(db.pool);
    const prompt = await promptFor(2, t.tenantId);
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
    const t = await seedTenant(db.pool);
    const prompt = await promptFor(1, t.tenantId);
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
    const t = await seedTenant(db.pool);
    const prompt = await promptFor(3, t.tenantId);
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

  it('os níveis de um cliente têm chave e posição únicas', async () => {
    const t = await seedTenant(db.pool);
    await db.pool.query(
      `INSERT INTO classification_dimension (tenant_id, output_key, label, position)
       VALUES ($1, 'tipo', 'Tipo', 1)`,
      [t.tenantId],
    );
    const dupKey = await sqlState(
      db.pool.query(
        `INSERT INTO classification_dimension (tenant_id, output_key, label, position)
         VALUES ($1, 'tipo', 'Outro', 2)`,
        [t.tenantId],
      ),
    );
    const dupPos = await sqlState(
      db.pool.query(
        `INSERT INTO classification_dimension (tenant_id, output_key, label, position)
         VALUES ($1, 'subTipo', 'Sub-Tipo', 1)`,
        [t.tenantId],
      ),
    );
    expect(dupKey).toBe(SQLSTATE.uniqueViolation);
    expect(dupPos).toBe(SQLSTATE.uniqueViolation);
  });

  it('a chave de saída é camelCase sem espaços', async () => {
    const t = await seedTenant(db.pool);
    for (const key of ['Tipo', 'sub tipo', 'sub-tipo', '1tipo']) {
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO classification_dimension (tenant_id, output_key, label, position)
           VALUES ($1, $2, 'x', 9)`,
          [t.tenantId, key],
        ),
      );
      expect(code, key).toBe(SQLSTATE.checkViolation);
    }
  });

  it('a configuração por ação exige temperatura entre 0 e 2', async () => {
    const t = await seedTenant(db.pool);
    const model = await db.pool.query<{ llm_model_id: number }>(
      `INSERT INTO llm_model (ai_provider_id, code) VALUES (1, 'modelo-teste') RETURNING llm_model_id`,
    );
    const modelId = model.rows[0]!.llm_model_id;
    const bad = await sqlState(
      db.pool.query(
        `INSERT INTO tenant_action_config (tenant_id, action_id, llm_model_id, temperature, max_output_tokens, timeout_ms)
         VALUES ($1, 1, $2, 2.5, 800, 15000)`,
        [t.tenantId, modelId],
      ),
    );
    expect(bad).toBe(SQLSTATE.checkViolation);
    await db.pool.query(
      `INSERT INTO tenant_action_config (tenant_id, action_id, llm_model_id, temperature, max_output_tokens, timeout_ms)
       VALUES ($1, 1, $2, 0.1, 800, 15000)`,
      [t.tenantId, modelId],
    );
  });
});
