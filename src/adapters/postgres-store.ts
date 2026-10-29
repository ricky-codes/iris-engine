import type { Pool } from 'pg';
import type { EngineStore, ToolSettings } from '../engine/store.js';
import type { ToolDefaults } from '../engine/tool.js';

export class PgEngineStore implements EngineStore {
  constructor(private readonly pool: Pool) {}

  async settingsFor(
    tool: string,
    defaults: ToolDefaults,
    defaultModel: string,
  ): Promise<ToolSettings> {
    const { rows } = await this.pool.query<{
      model: string | null;
      temperature: string | null;
      max_output_tokens: number | null;
      timeout_ms: number | null;
      is_enabled: boolean | null;
      system_template: string | null;
    }>(
      `SELECT lm.code AS model, tc.temperature, tc.max_output_tokens, tc.timeout_ms,
              tc.is_enabled, pv.system_template
       FROM tool t
       LEFT JOIN tool_config tc ON tc.tool_id = t.tool_id
       LEFT JOIN llm_model lm   ON lm.llm_model_id = tc.llm_model_id
       LEFT JOIN prompt p       ON p.tool_id = t.tool_id
       LEFT JOIN prompt_version pv ON pv.prompt_id = p.prompt_id AND pv.is_active
       WHERE t.code = $1`,
      [tool],
    );
    const row = rows[0];
    return {
      model: row?.model ?? defaultModel,
      temperature: row?.temperature == null ? defaults.temperature : Number(row.temperature),
      maxOutputTokens: row?.max_output_tokens ?? defaults.maxOutputTokens,
      timeoutMs: row?.timeout_ms ?? defaults.timeoutMs,
      enabled: row?.is_enabled ?? true,
      systemPrompt: row?.system_template ?? undefined,
    };
  }
}

/** Regista no catálogo as ferramentas que o código conhece. Não apaga as que já lá estão. */
export async function syncToolCatalog(pool: Pool, names: string[]): Promise<void> {
  await pool.query(
    'INSERT INTO tool (code) SELECT unnest($1::text[]) ON CONFLICT (code) DO NOTHING',
    [names],
  );
}
