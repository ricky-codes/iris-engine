import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgEngineStore, syncToolCatalog } from '../../src/adapters/postgres-store.js';
import { TEST_DATABASE_URL, addMemory, createTestDb, sfId, type TestDb } from './helpers.js';

const DEFAULTS = { temperature: 0.2, maxOutputTokens: 300, timeoutMs: 20_000 };

describe.skipIf(TEST_DATABASE_URL === undefined)('o que o motor lê da base de dados', () => {
  let db: TestDb;
  let store: PgEngineStore;
  beforeAll(async () => {
    db = await createTestDb();
    store = new PgEngineStore(db.pool);
  });
  afterAll(async () => {
    await db.close();
  });

  it('junta as memórias da org e do próprio utilizador, nunca as de outros', async () => {
    const org = sfId('00D');
    const me = sfId('005');
    await addMemory(db.pool, { org }, 'regra da org');
    await addMemory(db.pool, { org, user: me }, 'minha preferência');
    await addMemory(db.pool, { org, user: sfId('005') }, 'de um colega');
    await addMemory(db.pool, { org: sfId('00D') }, 'de outra org');

    expect(await store.memoriesFor({ orgId: org, userId: me, tool: 'reply' })).toEqual({
      org: ['regra da org'],
      user: ['minha preferência'],
    });
  });

  it('uma memória limitada a uma ferramenta só aparece nessa ferramenta', async () => {
    const org = sfId('00D');
    const id = await addMemory(db.pool, { org }, 'só nas respostas');
    await db.pool.query(
      `INSERT INTO memory_tool (memory_id, tool_id) SELECT $1, tool_id FROM tool WHERE code = 'reply'`,
      [id],
    );
    const user = sfId('005');
    expect((await store.memoriesFor({ orgId: org, userId: user, tool: 'reply' })).org).toEqual([
      'só nas respostas',
    ]);
    expect((await store.memoriesFor({ orgId: org, userId: user, tool: 'sentiment' })).org).toEqual(
      [],
    );
  });

  it('sem configuração na base de dados, usa os valores da ferramenta e o modelo por omissão', async () => {
    await syncToolCatalog(db.pool, ['diagnostic']);
    expect(await store.settingsFor('diagnostic', DEFAULTS, 'google/gemini-2.5-flash')).toEqual({
      ...DEFAULTS,
      model: 'google/gemini-2.5-flash',
      enabled: true,
      systemPrompt: undefined,
    });
  });

  it('a configuração e o prompt ativo da base de dados substituem os da ferramenta', async () => {
    await syncToolCatalog(db.pool, ['diagnostic', 'diagnostic']);
    const model = await db.pool.query<{ llm_model_id: number }>(
      `INSERT INTO llm_model (ai_provider_id, code) SELECT ai_provider_id, 'anthropic/claude-sonnet'
       FROM ai_provider WHERE code = 'openrouter' RETURNING llm_model_id`,
    );
    await db.pool.query(
      `INSERT INTO tool_config (tool_id, llm_model_id, temperature, max_output_tokens, timeout_ms, is_enabled)
       SELECT tool_id, $1, 0.5, 900, 9000, false FROM tool WHERE code = 'diagnostic'`,
      [model.rows[0]!.llm_model_id],
    );
    const prompt = await db.pool.query<{ prompt_id: number }>(
      `INSERT INTO prompt (tool_id) SELECT tool_id FROM tool WHERE code = 'diagnostic' RETURNING prompt_id`,
    );
    await db.pool.query(
      `INSERT INTO prompt_version (prompt_id, version, system_template, is_active)
       VALUES ($1, 1, 'antigo', false), ($1, 2, 'ativo', true)`,
      [prompt.rows[0]!.prompt_id],
    );

    expect(await store.settingsFor('diagnostic', DEFAULTS, 'x')).toEqual({
      model: 'anthropic/claude-sonnet',
      temperature: 0.5,
      maxOutputTokens: 900,
      timeoutMs: 9000,
      enabled: false,
      systemPrompt: 'ativo',
    });
    const { rows } = await db.pool.query("SELECT 1 FROM tool WHERE code = 'diagnostic'");
    expect(rows).toHaveLength(1);
  });
});
