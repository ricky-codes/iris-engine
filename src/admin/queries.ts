import type { Pool } from 'pg';
import type {
  Memory,
  MemoryFilter as CoreFilter,
  MemoryScope,
  MemorySource,
} from '../engine/memory.js';
import { memoriesIn } from './commands.js';

export type { MemoryScope, MemorySource };

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

const toRow = (m: Memory): MemoryRow => ({
  memoryId: m.id,
  scope: m.scope,
  source: m.source,
  sfOrgRef: m.orgId,
  sfUserRef: m.userId,
  content: m.content,
  tools: m.tools,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

const toFilter = (f: MemoryFilter): CoreFilter => ({
  ...(f.sfOrgRef !== undefined && { orgId: f.sfOrgRef }),
  ...(f.sfUserRef !== undefined && { userId: f.sfUserRef }),
  ...(f.scope !== undefined && { scope: f.scope }),
  ...(f.tool !== undefined && { tool: f.tool }),
  ...(f.search !== undefined && { search: f.search }),
});

/** Memórias da org primeiro, depois por utilizador; dentro de cada dono, as mais recentes primeiro. */
export async function listMemories(pool: Pool, filter: MemoryFilter = {}): Promise<MemoryRow[]> {
  return (await pageOfMemories(pool, filter, {})).items;
}

/** Uma página de memórias e quantas cumprem o filtro ao todo. */
export async function pageOfMemories(
  pool: Pool,
  filter: MemoryFilter,
  page: { limit?: number; offset?: number },
): Promise<{ items: MemoryRow[]; total: number }> {
  const { items, total } = await memoriesIn(pool).list(toFilter(filter), page);
  return { items: items.map(toRow), total };
}

export async function getMemory(pool: Pool, memoryId: string): Promise<MemoryRow | undefined> {
  const m = await memoriesIn(pool).get(memoryId);
  return m === undefined ? undefined : toRow(m);
}

export interface MemorySummary {
  sfOrgRef: string;
  org: { count: number; limit: number };
  users: { sfUserRef: string; count: number; limit: number }[];
}

/** Quantas memórias tem uma org e cada utilizador dela, face aos limites. */
export async function memorySummary(pool: Pool, sfOrgRef: string): Promise<MemorySummary> {
  const s = await memoriesIn(pool).summary(sfOrgRef);
  return {
    sfOrgRef: s.orgId,
    org: s.org,
    users: s.users.map((u) => ({ sfUserRef: u.userId, count: u.count, limit: u.limit })),
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
