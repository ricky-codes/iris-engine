import type { Pool } from 'pg';
import { MAX_ORG_MEMORIES, MAX_USER_MEMORIES } from '../memory/limits.js';

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

export interface MemoryFilter {
  sfOrgRef?: string;
  sfUserRef?: string;
  scope?: MemoryScope;
  /** Só memórias que valem para esta ferramenta (incluindo as que valem para todas). */
  tool?: string;
  /** Procura no texto (sem distinguir maiúsculas). */
  search?: string;
}

const SELECT = `
  SELECT m.memory_id, sc.code AS scope, so.code AS source,
         COALESCE(om.sf_org_ref, um.sf_org_ref) AS sf_org_ref, um.sf_user_ref,
         m.content, m.created_at, m.updated_at,
         ARRAY(SELECT t.code FROM memory_tool mt JOIN tool t ON t.tool_id = mt.tool_id
               WHERE mt.memory_id = m.memory_id ORDER BY t.code) AS tools
  FROM memory m
  JOIN memory_scope sc  ON sc.memory_scope_id = m.memory_scope_id
  JOIN memory_source so ON so.memory_source_id = m.memory_source_id
  LEFT JOIN org_memory om  ON om.memory_id = m.memory_id
  LEFT JOIN user_memory um ON um.memory_id = m.memory_id`;

const WHERE = `
  WHERE ($1::text IS NULL OR COALESCE(om.sf_org_ref, um.sf_org_ref) = $1)
    AND ($2::text IS NULL OR um.sf_user_ref = $2)
    AND ($3::text IS NULL OR sc.code = $3)
    AND ($4::text IS NULL
         OR NOT EXISTS (SELECT 1 FROM memory_tool mt WHERE mt.memory_id = m.memory_id)
         OR EXISTS (SELECT 1 FROM memory_tool mt JOIN tool t ON t.tool_id = mt.tool_id
                    WHERE mt.memory_id = m.memory_id AND t.code = $4))
    AND ($5::text IS NULL OR m.content ILIKE '%' || $5 || '%')`;

const ORDER = `
  ORDER BY sc.code, COALESCE(om.sf_org_ref, um.sf_org_ref), um.sf_user_ref NULLS FIRST,
           m.created_at DESC, m.memory_id`;

interface RawMemory {
  memory_id: string;
  scope: MemoryScope;
  source: MemorySource;
  sf_org_ref: string;
  sf_user_ref: string | null;
  content: string;
  tools: string[];
  created_at: Date;
  updated_at: Date;
}

const toRow = (r: RawMemory): MemoryRow => ({
  memoryId: r.memory_id,
  scope: r.scope,
  source: r.source,
  sfOrgRef: r.sf_org_ref,
  sfUserRef: r.sf_user_ref,
  content: r.content,
  tools: r.tools,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const params = (f: MemoryFilter): (string | null)[] => [
  f.sfOrgRef ?? null,
  f.sfUserRef ?? null,
  f.scope ?? null,
  f.tool ?? null,
  // Os carateres especiais do ILIKE contam como texto normal.
  f.search === undefined ? null : f.search.replace(/[\\%_]/g, (c) => `\\${c}`),
];

/** Memórias da org primeiro, depois por utilizador; dentro de cada dono, as mais recentes primeiro. */
export async function listMemories(
  pool: Pool,
  filter: MemoryFilter = {},
  page: { limit?: number; offset?: number } = {},
): Promise<MemoryRow[]> {
  const { rows } = await pool.query<RawMemory>(`${SELECT} ${WHERE} ${ORDER} LIMIT $6 OFFSET $7`, [
    ...params(filter),
    page.limit ?? null,
    page.offset ?? 0,
  ]);
  return rows.map(toRow);
}

export async function countMemories(pool: Pool, filter: MemoryFilter = {}): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${SELECT} ${WHERE}) x`,
    params(filter),
  );
  return rows[0]?.n ?? 0;
}

export async function getMemory(pool: Pool, memoryId: string): Promise<MemoryRow | undefined> {
  const { rows } = await pool.query<RawMemory>(`${SELECT} WHERE m.memory_id = $1`, [memoryId]);
  const row = rows[0];
  return row === undefined ? undefined : toRow(row);
}

export interface MemorySummary {
  sfOrgRef: string;
  org: { count: number; limit: number };
  users: { sfUserRef: string; count: number; limit: number }[];
}

/** Quantas memórias tem uma org e cada utilizador dela, face aos limites. */
export async function memorySummary(pool: Pool, sfOrgRef: string): Promise<MemorySummary> {
  const org = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM org_memory WHERE sf_org_ref = $1',
    [sfOrgRef],
  );
  const users = await pool.query<{ sf_user_ref: string; n: number }>(
    `SELECT sf_user_ref, count(*)::int AS n FROM user_memory WHERE sf_org_ref = $1
     GROUP BY sf_user_ref ORDER BY sf_user_ref`,
    [sfOrgRef],
  );
  return {
    sfOrgRef,
    org: { count: org.rows[0]?.n ?? 0, limit: MAX_ORG_MEMORIES },
    users: users.rows.map((u) => ({
      sfUserRef: u.sf_user_ref,
      count: u.n,
      limit: MAX_USER_MEMORIES,
    })),
  };
}

export async function listTools(pool: Pool): Promise<ToolRow[]> {
  const { rows } = await pool.query<ToolRow>('SELECT code FROM tool ORDER BY code');
  return rows;
}

/** Tudo o que a interface de terminal mostra, carregado de uma vez. */
export interface AdminData {
  memories: MemoryRow[];
  tools: ToolRow[];
}
