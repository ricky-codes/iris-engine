import type { Pool, PoolClient } from 'pg';
import { EngineError } from '../engine/errors.js';
import {
  MAX_ORG_MEMORIES,
  MAX_USER_MEMORIES,
  type Memory,
  type MemoryFilter,
  type MemoryOwner,
  type MemoryScope,
  type MemorySource,
  type MemoryStore,
  type MemorySummary,
  type RequestMemories,
} from '../engine/memory.js';

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

const toMemory = (r: RawMemory): Memory => ({
  id: r.memory_id,
  scope: r.scope,
  source: r.source,
  orgId: r.sf_org_ref,
  userId: r.sf_user_ref,
  content: r.content,
  tools: r.tools,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const params = (f: MemoryFilter): (string | null)[] => [
  f.orgId ?? null,
  f.userId ?? null,
  f.scope ?? null,
  f.tool ?? null,
  // Os carateres especiais do ILIKE contam como texto normal.
  f.search === undefined ? null : f.search.replace(/[\\%_]/g, (c) => `\\${c}`),
];

// Âmbito (migração 0001) e origem (migração 0009) por código.
const SCOPE_ID: Record<MemoryScope, number> = { org: 2, user: 3 };
const SOURCE_ID: Record<MemorySource, number> = { user: 1, admin: 2 };

const isMemoryLimit = (err: unknown): boolean =>
  err instanceof Error && err.message.startsWith('memory_limit:');

function limitReached(owner: MemoryOwner): EngineError {
  return owner.userId === undefined
    ? new EngineError(
        'memory_limit_reached',
        `A org ${owner.orgId} já tem ${String(MAX_ORG_MEMORIES)} memórias. Apague uma antes de criar outra.`,
      )
    : new EngineError(
        'memory_limit_reached',
        `O utilizador ${owner.userId} já tem ${String(MAX_USER_MEMORIES)} memórias. Apague uma antes de criar outra.`,
      );
}

/** As memórias no Postgres. Os limites por dono são aplicados pela própria base de dados. */
export class PgMemoryStore implements MemoryStore {
  constructor(private readonly pool: Pool) {}

  async forRequest({
    orgId,
    userId,
    tool,
  }: {
    orgId: string;
    userId: string;
    tool: string;
  }): Promise<RequestMemories> {
    // Memórias da org e do utilizador que valem para esta ferramenta (ou para todas).
    const { rows } = await this.pool.query<{ scope: MemoryScope; content: string }>(
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

  async list(filter: MemoryFilter, page: { limit?: number; offset?: number }): Promise<Memory[]> {
    const { rows } = await this.pool.query<RawMemory>(
      `${SELECT} ${WHERE} ${ORDER} LIMIT $6 OFFSET $7`,
      [...params(filter), page.limit ?? null, page.offset ?? 0],
    );
    return rows.map(toMemory);
  }

  async count(filter: MemoryFilter): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${SELECT} ${WHERE}) x`,
      params(filter),
    );
    return rows[0]?.n ?? 0;
  }

  async get(id: string): Promise<Memory | undefined> {
    const { rows } = await this.pool.query<RawMemory>(`${SELECT} WHERE m.memory_id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? undefined : toMemory(row);
  }

  async create(input: {
    owner: MemoryOwner;
    source: MemorySource;
    content: string;
    tools: string[];
  }): Promise<string> {
    const { owner } = input;
    const scope: MemoryScope = owner.userId === undefined ? 'org' : 'user';
    return this.transaction(async (client) => {
      const toolIds = await resolveTools(client, input.tools);
      const { rows } = await client.query<{ memory_id: string }>(
        `INSERT INTO memory (memory_scope_id, memory_source_id, content)
         VALUES ($1, $2, $3) RETURNING memory_id`,
        [SCOPE_ID[scope], SOURCE_ID[input.source], input.content],
      );
      const id = rows[0]?.memory_id ?? '';
      try {
        if (owner.userId === undefined) {
          await client.query('INSERT INTO org_memory (memory_id, sf_org_ref) VALUES ($1, $2)', [
            id,
            owner.orgId,
          ]);
        } else {
          await client.query(
            'INSERT INTO user_memory (memory_id, sf_org_ref, sf_user_ref) VALUES ($1, $2, $3)',
            [id, owner.orgId, owner.userId],
          );
        }
      } catch (err) {
        throw isMemoryLimit(err) ? limitReached(owner) : err;
      }
      await setMemoryTools(client, id, toolIds);
      return id;
    });
  }

  async update(id: string, change: { content?: string; tools?: string[] }): Promise<void> {
    await this.transaction(async (client) => {
      if (change.content !== undefined) {
        await client.query(
          'UPDATE memory SET content = $2, updated_at = now() WHERE memory_id = $1',
          [id, change.content],
        );
      }
      if (change.tools !== undefined) {
        const toolIds = await resolveTools(client, change.tools);
        await client.query('DELETE FROM memory_tool WHERE memory_id = $1', [id]);
        await setMemoryTools(client, id, toolIds);
        await client.query('UPDATE memory SET updated_at = now() WHERE memory_id = $1', [id]);
      }
    });
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM memory WHERE memory_id = $1', [id]);
    return rowCount === 1;
  }

  async deleteAllOf(owner: MemoryOwner): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM memory m
       WHERE m.memory_id IN (
         SELECT memory_id FROM user_memory
         WHERE sf_org_ref = $1 AND ($2::text IS NULL OR sf_user_ref = $2)
         UNION ALL
         SELECT memory_id FROM org_memory WHERE sf_org_ref = $1 AND $2::text IS NULL
       )`,
      [owner.orgId, owner.userId ?? null],
    );
    return rowCount ?? 0;
  }

  async summary(orgId: string): Promise<MemorySummary> {
    const org = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM org_memory WHERE sf_org_ref = $1',
      [orgId],
    );
    const users = await this.pool.query<{ sf_user_ref: string; n: number }>(
      `SELECT sf_user_ref, count(*)::int AS n FROM user_memory WHERE sf_org_ref = $1
       GROUP BY sf_user_ref ORDER BY sf_user_ref`,
      [orgId],
    );
    return {
      orgId,
      org: { count: org.rows[0]?.n ?? 0, limit: MAX_ORG_MEMORIES },
      users: users.rows.map((u) => ({
        userId: u.sf_user_ref,
        count: u.n,
        limit: MAX_USER_MEMORIES,
      })),
    };
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Ids das ferramentas pelo código. Erro se alguma não existir no catálogo. */
async function resolveTools(client: PoolClient, codes: string[]): Promise<number[]> {
  const known = await client.query<{ tool_id: number; code: string }>(
    'SELECT tool_id, code FROM tool WHERE code = ANY($1::text[])',
    [codes],
  );
  const missing = codes.filter((t) => !known.rows.some((r) => r.code === t));
  if (missing.length > 0) {
    throw new EngineError('invalid_request', `Ferramenta desconhecida: ${missing.join(', ')}.`);
  }
  return known.rows.map((r) => r.tool_id);
}

async function setMemoryTools(client: PoolClient, memoryId: string, toolIds: number[]) {
  for (const toolId of toolIds) {
    await client.query('INSERT INTO memory_tool (memory_id, tool_id) VALUES ($1, $2)', [
      memoryId,
      toolId,
    ]);
  }
}
