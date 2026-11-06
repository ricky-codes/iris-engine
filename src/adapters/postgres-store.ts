import type { Pool } from 'pg';
import {
  fallbackChain,
  type EngineStore,
  type ModelDefaults,
  type StoredToolSettings,
  type ToolOverrides,
} from '../engine/store.js';

interface OverrideColumns {
  max_attempts: number | null;
  total_timeout_ms: number | null;
  rate_limit_per_minute: number | null;
  stream_enabled: boolean | null;
}

const OVERRIDE_COLUMNS =
  'tc.max_attempts, tc.total_timeout_ms, tc.rate_limit_per_minute, tc.stream_enabled';

/** As colunas das substituições (sem configuração gravada vêm todas a NULL). */
export const toOverrides = (r: Partial<OverrideColumns> | undefined): ToolOverrides => ({
  maxAttempts: r?.max_attempts ?? null,
  totalTimeoutMs: r?.total_timeout_ms ?? null,
  rateLimitPerMinute: r?.rate_limit_per_minute ?? null,
  streamEnabled: r?.stream_enabled ?? null,
});
import type { ToolDefaults } from '../engine/tool.js';

export class PgEngineStore implements EngineStore {
  constructor(private readonly pool: Pool) {}

  async settingsFor(
    tool: string,
    defaults: ToolDefaults,
    models: ModelDefaults,
  ): Promise<StoredToolSettings> {
    const { rows } = await this.pool.query<
      OverrideColumns & {
        model: string | null;
        temperature: string | null;
        max_output_tokens: number | null;
        timeout_ms: number | null;
        is_enabled: boolean | null;
        system_template: string | null;
        fallbacks: string[] | null;
      }
    >(
      `SELECT lm.code AS model, tc.temperature, tc.max_output_tokens, tc.timeout_ms,
              tc.is_enabled, pv.system_template, ${OVERRIDE_COLUMNS},
              CASE WHEN tc.tool_id IS NULL THEN NULL ELSE
                ARRAY(SELECT fm.code FROM tool_config_fallback f
                      JOIN llm_model fm ON fm.llm_model_id = f.llm_model_id
                      WHERE f.tool_id = tc.tool_id ORDER BY f.position) END AS fallbacks
       FROM tool t
       LEFT JOIN tool_config tc ON tc.tool_id = t.tool_id
       LEFT JOIN llm_model lm   ON lm.llm_model_id = tc.llm_model_id
       LEFT JOIN prompt p       ON p.tool_id = t.tool_id
       LEFT JOIN prompt_version pv ON pv.prompt_id = p.prompt_id AND pv.is_active
       WHERE t.code = $1`,
      [tool],
    );
    const row = rows[0];
    const model = row?.model ?? models.model;
    return {
      model,
      // Com configuração gravada valem os seus modelos de recurso (mesmo nenhum); sem ela, os do motor.
      fallbackModels: fallbackChain(model, row?.fallbacks ?? models.fallbackModels),
      temperature: row?.temperature == null ? defaults.temperature : Number(row.temperature),
      maxOutputTokens: row?.max_output_tokens ?? defaults.maxOutputTokens,
      timeoutMs: row?.timeout_ms ?? defaults.timeoutMs,
      enabled: row?.is_enabled ?? true,
      systemPrompt: row?.system_template ?? undefined,
      overrides: toOverrides(row),
    };
  }

  async overridesForAll(): Promise<Map<string, ToolOverrides>> {
    const { rows } = await this.pool.query<OverrideColumns & { code: string }>(
      `SELECT t.code, ${OVERRIDE_COLUMNS}
       FROM tool t JOIN tool_config tc ON tc.tool_id = t.tool_id`,
    );
    return new Map(rows.map((r) => [r.code, toOverrides(r)]));
  }
}

/** Regista no catálogo as ferramentas que o código conhece. Não apaga as que já lá estão. */
export async function syncToolCatalog(pool: Pool, names: string[]): Promise<void> {
  await pool.query(
    'INSERT INTO tool (code) SELECT unnest($1::text[]) ON CONFLICT (code) DO NOTHING',
    [names],
  );
}
