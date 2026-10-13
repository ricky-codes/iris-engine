import type { Pool, PoolClient } from 'pg';
import { AdminError } from './commands.js';

/**
 * Configuração das ferramentas e versões dos prompts, editáveis pelo admin.
 * O motor lê estes valores em cada pedido: uma alteração vale a partir do pedido seguinte.
 */

export interface ToolConfigInput {
  /** Id do modelo no OpenRouter (ex.: `google/gemini-2.5-flash`). */
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface StoredToolConfig extends ToolConfigInput {
  source: 'database';
}

export interface PromptVersionRow {
  version: number;
  isActive: boolean;
  systemTemplate: string;
  changeNote: string | null;
  createdAt: Date;
}

export interface ToolCatalogRow {
  name: string;
  config: StoredToolConfig | null;
  activePromptVersion: number | null;
  promptVersionCount: number;
}

/** Todas as ferramentas do catálogo, com a configuração e a versão ativa do prompt, se houver. */
export async function listToolCatalog(pool: Pool): Promise<ToolCatalogRow[]> {
  const { rows } = await pool.query<{
    code: string;
    model: string | null;
    temperature: string | null;
    max_output_tokens: number | null;
    timeout_ms: number | null;
    is_enabled: boolean | null;
    active_version: number | null;
    version_count: number;
  }>(
    `SELECT t.code, lm.code AS model, tc.temperature, tc.max_output_tokens, tc.timeout_ms,
            tc.is_enabled,
            (SELECT pv.version FROM prompt p JOIN prompt_version pv ON pv.prompt_id = p.prompt_id
              WHERE p.tool_id = t.tool_id AND pv.is_active) AS active_version,
            (SELECT count(*)::int FROM prompt p JOIN prompt_version pv ON pv.prompt_id = p.prompt_id
              WHERE p.tool_id = t.tool_id) AS version_count
     FROM tool t
     LEFT JOIN tool_config tc ON tc.tool_id = t.tool_id
     LEFT JOIN llm_model lm   ON lm.llm_model_id = tc.llm_model_id
     ORDER BY t.code`,
  );
  return rows.map((r) => ({
    name: r.code,
    config:
      r.model === null ||
      r.temperature === null ||
      r.max_output_tokens === null ||
      r.timeout_ms === null ||
      r.is_enabled === null
        ? null
        : {
            model: r.model,
            temperature: Number(r.temperature),
            maxOutputTokens: r.max_output_tokens,
            timeoutMs: r.timeout_ms,
            enabled: r.is_enabled,
            source: 'database',
          },
    activePromptVersion: r.active_version,
    promptVersionCount: r.version_count,
  }));
}

async function toolId(db: Pool | PoolClient, name: string): Promise<number> {
  const { rows } = await db.query<{ tool_id: number }>('SELECT tool_id FROM tool WHERE code = $1', [
    name,
  ]);
  const id = rows[0]?.tool_id;
  if (id === undefined) throw new AdminError(`A ferramenta "${name}" não existe.`, 'not_found');
  return id;
}

/** Grava a configuração da ferramenta. O modelo entra no catálogo `llm_model` se for novo. */
export async function saveToolConfig(
  pool: Pool,
  name: string,
  input: ToolConfigInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await toolId(client, name);
    await client.query(
      `INSERT INTO llm_model (ai_provider_id, code)
       SELECT ai_provider_id, $1 FROM ai_provider WHERE code = 'openrouter'
       ON CONFLICT (ai_provider_id, code) DO NOTHING`,
      [input.model],
    );
    const model = await client.query<{ llm_model_id: number }>(
      `SELECT lm.llm_model_id FROM llm_model lm JOIN ai_provider ap USING (ai_provider_id)
       WHERE ap.code = 'openrouter' AND lm.code = $1`,
      [input.model],
    );
    await client.query(
      `INSERT INTO tool_config (tool_id, llm_model_id, temperature, max_output_tokens, timeout_ms, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tool_id) DO UPDATE SET
         llm_model_id = EXCLUDED.llm_model_id, temperature = EXCLUDED.temperature,
         max_output_tokens = EXCLUDED.max_output_tokens, timeout_ms = EXCLUDED.timeout_ms,
         is_enabled = EXCLUDED.is_enabled`,
      [
        id,
        model.rows[0]?.llm_model_id,
        input.temperature,
        input.maxOutputTokens,
        input.timeoutMs,
        input.enabled,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Apaga a configuração: a ferramenta volta aos valores do código e fica ligada. */
export async function resetToolConfig(pool: Pool, name: string): Promise<void> {
  const id = await toolId(pool, name);
  await pool.query('DELETE FROM tool_config WHERE tool_id = $1', [id]);
}

export async function listPromptVersions(pool: Pool, name: string): Promise<PromptVersionRow[]> {
  const id = await toolId(pool, name);
  const { rows } = await pool.query<{
    version: number;
    is_active: boolean;
    system_template: string;
    change_note: string | null;
    created_at: Date;
  }>(
    `SELECT pv.version, pv.is_active, pv.system_template, pv.change_note, pv.created_at
     FROM prompt p JOIN prompt_version pv ON pv.prompt_id = p.prompt_id
     WHERE p.tool_id = $1 ORDER BY pv.version DESC`,
    [id],
  );
  return rows.map((r) => ({
    version: r.version,
    isActive: r.is_active,
    systemTemplate: r.system_template,
    changeNote: r.change_note,
    createdAt: r.created_at,
  }));
}

/** Cria a versão seguinte do prompt. Uma versão nunca muda depois de criada. */
export async function createPromptVersion(
  pool: Pool,
  name: string,
  input: { systemTemplate: string; changeNote?: string; activate: boolean },
): Promise<{ version: number }> {
  if (input.systemTemplate.trim() === '') throw new AdminError('O prompt não pode estar vazio.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await toolId(client, name);
    await client.query(
      'INSERT INTO prompt (tool_id) VALUES ($1) ON CONFLICT (tool_id) DO NOTHING',
      [id],
    );
    // Bloqueia o prompt: duas criações em simultâneo não podem ficar com o mesmo número.
    const prompt = await client.query<{ prompt_id: number }>(
      'SELECT prompt_id FROM prompt WHERE tool_id = $1 FOR UPDATE',
      [id],
    );
    const promptId = prompt.rows[0]?.prompt_id;
    const next = await client.query<{ v: number }>(
      'SELECT COALESCE(max(version), 0)::int + 1 AS v FROM prompt_version WHERE prompt_id = $1',
      [promptId],
    );
    const version = next.rows[0]?.v ?? 1;
    if (input.activate) {
      await client.query('UPDATE prompt_version SET is_active = false WHERE prompt_id = $1', [
        promptId,
      ]);
    }
    await client.query(
      `INSERT INTO prompt_version (prompt_id, version, system_template, change_note, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [promptId, version, input.systemTemplate, input.changeNote ?? null, input.activate],
    );
    await client.query('COMMIT');
    return { version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Escolhe a versão ativa do prompt. `null` desativa todas: a ferramenta volta ao prompt do código.
 */
export async function setActivePromptVersion(
  pool: Pool,
  name: string,
  version: number | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await toolId(client, name);
    const prompt = await client.query<{ prompt_id: number }>(
      'SELECT prompt_id FROM prompt WHERE tool_id = $1 FOR UPDATE',
      [id],
    );
    const promptId = prompt.rows[0]?.prompt_id;
    if (promptId === undefined) {
      if (version === null) {
        await client.query('COMMIT');
        return;
      }
      throw new AdminError(`A versão ${String(version)} não existe.`, 'not_found');
    }
    await client.query('UPDATE prompt_version SET is_active = false WHERE prompt_id = $1', [
      promptId,
    ]);
    if (version !== null) {
      const { rowCount } = await client.query(
        'UPDATE prompt_version SET is_active = true WHERE prompt_id = $1 AND version = $2',
        [promptId, version],
      );
      if (rowCount !== 1)
        throw new AdminError(`A versão ${String(version)} não existe.`, 'not_found');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
