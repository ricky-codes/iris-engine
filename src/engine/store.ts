import type { Pool } from 'pg';
import type { ToolDefaults } from './tool.js';

export interface RequestMemories {
  /** Regras da empresa. Prevalecem sobre as do utilizador. */
  org: string[];
  /** Preferências do próprio utilizador. */
  user: string[];
}

export interface ToolSettings extends ToolDefaults {
  model: string;
  enabled: boolean;
  /** Prompt ativo na base de dados, se existir. Senão usa-se o da ferramenta. */
  systemPrompt: string | undefined;
}

/** O que o motor lê da base de dados em cada pedido. Nunca escreve. */
export interface EngineStore {
  memoriesFor(request: { orgId: string; userId: string; tool: string }): Promise<RequestMemories>;
  settingsFor(tool: string, defaults: ToolDefaults, defaultModel: string): Promise<ToolSettings>;
}

export class PgEngineStore implements EngineStore {
  constructor(private readonly pool: Pool) {}

  async memoriesFor({
    orgId,
    userId,
    tool,
  }: {
    orgId: string;
    userId: string;
    tool: string;
  }): Promise<RequestMemories> {
    // Memórias da org e do utilizador que valem para esta ferramenta (ou para todas).
    const { rows } = await this.pool.query<{ scope: 'org' | 'user'; content: string }>(
      `SELECT sc.code AS scope, m.content
       FROM memory m
       JOIN memory_scope sc ON sc.memory_scope_id = m.memory_scope_id
       LEFT JOIN org_memory om  ON om.memory_id = m.memory_id
       LEFT JOIN user_memory um ON um.memory_id = m.memory_id
       WHERE (om.sf_org_ref = $1 OR (um.sf_org_ref = $1 AND um.sf_user_ref = $2))
         AND (NOT EXISTS (SELECT 1 FROM memory_tool mt WHERE mt.memory_id = m.memory_id)
              OR EXISTS (SELECT 1 FROM memory_tool mt JOIN tool t ON t.tool_id = mt.tool_id
                         WHERE mt.memory_id = m.memory_id AND t.code = $3))
       ORDER BY m.created_at, m.memory_id`,
      [orgId, userId, tool],
    );
    return {
      org: rows.filter((r) => r.scope === 'org').map((r) => r.content),
      user: rows.filter((r) => r.scope === 'user').map((r) => r.content),
    };
  }

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
