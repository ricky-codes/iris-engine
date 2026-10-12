import type { Pool } from 'pg';

export type MemoryScope = 'org' | 'user';
export type MemorySource = 'user' | 'admin';

export interface MemoryRow {
  memoryId: string;
  scope: MemoryScope;
  source: MemorySource;
  sfOrgRef: string;
  /** Só nas memórias de utilizador. */
  sfUserRef: string | null;
  content: string;
  /** Códigos das ferramentas a que se aplica. Vazio: todas. */
  tools: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolRow {
  code: string;
}

/** Todas as memórias, da org primeiro e depois por utilizador, mais recentes primeiro. */
export async function listMemories(
  pool: Pool,
  filter: { sfOrgRef?: string; sfUserRef?: string } = {},
): Promise<MemoryRow[]> {
  const { rows } = await pool.query<{
    memory_id: string;
    scope: MemoryScope;
    source: MemorySource;
    sf_org_ref: string;
    sf_user_ref: string | null;
    content: string;
    tools: string[];
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT m.memory_id, sc.code AS scope, so.code AS source,
            COALESCE(om.sf_org_ref, um.sf_org_ref) AS sf_org_ref, um.sf_user_ref,
            m.content, m.created_at, m.updated_at,
            ARRAY(SELECT t.code FROM memory_tool mt JOIN tool t ON t.tool_id = mt.tool_id
                  WHERE mt.memory_id = m.memory_id ORDER BY t.code) AS tools
     FROM memory m
     JOIN memory_scope sc  ON sc.memory_scope_id = m.memory_scope_id
     JOIN memory_source so ON so.memory_source_id = m.memory_source_id
     LEFT JOIN org_memory om  ON om.memory_id = m.memory_id
     LEFT JOIN user_memory um ON um.memory_id = m.memory_id
     WHERE ($1::text IS NULL OR COALESCE(om.sf_org_ref, um.sf_org_ref) = $1)
       AND ($2::text IS NULL OR um.sf_user_ref = $2)
     ORDER BY sc.code, COALESCE(om.sf_org_ref, um.sf_org_ref), um.sf_user_ref NULLS FIRST,
              m.created_at DESC`,
    [filter.sfOrgRef ?? null, filter.sfUserRef ?? null],
  );
  return rows.map((r) => ({
    memoryId: r.memory_id,
    scope: r.scope,
    source: r.source,
    sfOrgRef: r.sf_org_ref,
    sfUserRef: r.sf_user_ref,
    content: r.content,
    tools: r.tools,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function listTools(pool: Pool): Promise<ToolRow[]> {
  const { rows } = await pool.query<ToolRow>('SELECT code FROM tool ORDER BY code');
  return rows;
}

/** Tudo o que a interface mostra, carregado de uma vez. */
export interface AdminData {
  memories: MemoryRow[];
  tools: ToolRow[];
}
