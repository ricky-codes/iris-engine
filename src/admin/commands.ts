import type { Pool, PoolClient } from 'pg';
import { MAX_ORG_MEMORIES } from '../memory/limits.js';
import {
  firstError,
  validateMemoryContent,
  validateOrgRef,
  validateUserRef,
} from './validation.js';

/**
 * Operações de administração das memórias. Orgs e utilizadores não se gerem aqui:
 * vivem só no StepAccess. Corre-se a partir do terminal (src/admin/cli.ts).
 */

/** `invalid`: dados errados · `not_found`: não existe · `limit`: limite de memórias · `forbidden`: operação não permitida. */
export type AdminErrorKind = 'invalid' | 'not_found' | 'limit' | 'forbidden';

export class AdminError extends Error {
  constructor(
    message: string,
    public readonly kind: AdminErrorKind = 'invalid',
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

const isMemoryLimit = (err: unknown): boolean =>
  err instanceof Error && err.message.startsWith('memory_limit:');

/**
 * Cria uma memória da org: uma regra da empresa, válida para todos os utilizadores da org.
 * Só um admin da Step as cria. Sem ferramentas, vale para todas.
 */
export async function createOrgMemory(
  pool: Pool,
  input: { sfOrgRef: string; content: string; tools?: string[] },
): Promise<{ memoryId: string }> {
  const invalid = firstError([
    ['org-id', validateOrgRef, input.sfOrgRef],
    ['texto', validateMemoryContent, input.content],
  ]);
  if (invalid) throw new AdminError(`${invalid.field}: ${invalid.message}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const toolIds = await resolveTools(client, input.tools ?? []);

    // Âmbito 2 = org; origem 2 = admin (ver migração 0009).
    const { rows } = await client.query<{ memory_id: string }>(
      `INSERT INTO memory (memory_scope_id, memory_source_id, content)
       VALUES (2, 2, $1) RETURNING memory_id`,
      [input.content.trim()],
    );
    const memoryId = rows[0]?.memory_id ?? '';
    await client.query('INSERT INTO org_memory (memory_id, sf_org_ref) VALUES ($1, $2)', [
      memoryId,
      input.sfOrgRef,
    ]);
    await setMemoryTools(client, memoryId, toolIds);
    await client.query('COMMIT');
    return { memoryId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isMemoryLimit(err)) {
      throw new AdminError(
        `A org ${input.sfOrgRef} já tem ${String(MAX_ORG_MEMORIES)} memórias. Apague uma antes de criar outra.`,
        'limit',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Apaga uma memória (da org ou de um utilizador). */
export async function deleteMemory(pool: Pool, input: { memoryId: string }): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM memory WHERE memory_id = $1', [
    input.memoryId,
  ]);
  if (rowCount !== 1) throw new AdminError('A memória já não existe.', 'not_found');
}

/**
 * Altera o texto e/ou as ferramentas de uma memória da org. As memórias de utilizador
 * pertencem ao utilizador: o admin só as pode apagar.
 */
export async function updateOrgMemory(
  pool: Pool,
  input: { memoryId: string; content?: string; tools?: string[] },
): Promise<void> {
  if (input.content !== undefined) {
    const invalid = validateMemoryContent(input.content);
    if (invalid !== undefined) throw new AdminError(`texto: ${invalid}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ scope: string }>(
      `SELECT sc.code AS scope FROM memory m
       JOIN memory_scope sc ON sc.memory_scope_id = m.memory_scope_id
       WHERE m.memory_id = $1 FOR UPDATE OF m`,
      [input.memoryId],
    );
    const scope = found.rows[0]?.scope;
    if (scope === undefined) throw new AdminError('A memória já não existe.', 'not_found');
    if (scope !== 'org') {
      throw new AdminError(
        'As memórias de utilizador só podem ser apagadas, não alteradas.',
        'forbidden',
      );
    }

    if (input.content !== undefined) {
      await client.query(
        'UPDATE memory SET content = $2, updated_at = now() WHERE memory_id = $1',
        [input.memoryId, input.content.trim()],
      );
    }
    if (input.tools !== undefined) {
      const toolIds = await resolveTools(client, input.tools);
      await client.query('DELETE FROM memory_tool WHERE memory_id = $1', [input.memoryId]);
      await setMemoryTools(client, input.memoryId, toolIds);
      await client.query('UPDATE memory SET updated_at = now() WHERE memory_id = $1', [
        input.memoryId,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Ids das ferramentas pelo código. Erro se alguma não existir no catálogo. */
async function resolveTools(client: PoolClient, codes: string[]): Promise<number[]> {
  const unique = [...new Set(codes)];
  const known = await client.query<{ tool_id: number; code: string }>(
    'SELECT tool_id, code FROM tool WHERE code = ANY($1::text[])',
    [unique],
  );
  const missing = unique.filter((t) => !known.rows.some((r) => r.code === t));
  if (missing.length > 0) throw new AdminError(`Ferramenta desconhecida: ${missing.join(', ')}.`);
  return known.rows.map((r) => r.tool_id);
}

async function setMemoryTools(
  client: PoolClient,
  memoryId: string,
  toolIds: number[],
): Promise<void> {
  for (const toolId of toolIds) {
    await client.query('INSERT INTO memory_tool (memory_id, tool_id) VALUES ($1, $2)', [
      memoryId,
      toolId,
    ]);
  }
}

/**
 * Apaga todas as memórias de um utilizador, ou de uma org (as da org e as de todos os
 * seus utilizadores). Serve para quando a org ou o utilizador sai do StepAccess.
 */
export async function deleteMemoriesOf(
  pool: Pool,
  input: { sfOrgRef: string; sfUserRef?: string },
): Promise<number> {
  const invalid = firstError([
    ['org-id', validateOrgRef, input.sfOrgRef],
    ...(input.sfUserRef === undefined
      ? []
      : [['user-id', validateUserRef, input.sfUserRef] as const]),
  ]);
  if (invalid) throw new AdminError(`${invalid.field}: ${invalid.message}`);

  const { rowCount } = await pool.query(
    `DELETE FROM memory m
     WHERE m.memory_id IN (
       SELECT memory_id FROM user_memory
       WHERE sf_org_ref = $1 AND ($2::text IS NULL OR sf_user_ref = $2)
       UNION ALL
       SELECT memory_id FROM org_memory WHERE sf_org_ref = $1 AND $2::text IS NULL
     )`,
    [input.sfOrgRef, input.sfUserRef ?? null],
  );
  return rowCount ?? 0;
}
