import type { Pool } from 'pg';
import { PgMemoryStore } from '../adapters/postgres-memory-store.js';
import { Memories } from '../engine/memory.js';
import {
  firstError,
  validateMemoryContent,
  validateOrgRef,
  validateUserRef,
} from './validation.js';

/**
 * Operações de administração das memórias. Validam os ids do Salesforce e passam ao
 * núcleo (`Memories`), que aplica as regras. Orgs e utilizadores não se gerem aqui:
 * vivem só no StepAccess. Usadas pela CLI, pela interface de terminal e pela API.
 */

/** `invalid`: dados errados · `not_found`: não existe. Os erros das memórias vêm do núcleo (`EngineError`). */
export type AdminErrorKind = 'invalid' | 'not_found';

export class AdminError extends Error {
  constructor(
    message: string,
    public readonly kind: AdminErrorKind = 'invalid',
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/** As memórias pelo núcleo do motor, guardadas no Postgres. */
export const memoriesIn = (pool: Pool): Memories => new Memories(new PgMemoryStore(pool));

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

  const m = await memoriesIn(pool).remember({
    owner: { orgId: input.sfOrgRef },
    source: 'admin',
    content: input.content,
    tools: input.tools ?? [],
  });
  return { memoryId: m.id };
}

/** Apaga uma memória (da org ou de um utilizador). */
export async function deleteMemory(pool: Pool, input: { memoryId: string }): Promise<void> {
  await memoriesIn(pool).forget(input.memoryId);
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
  await memoriesIn(pool).update(input.memoryId, {
    ...(input.content !== undefined && { content: input.content }),
    ...(input.tools !== undefined && { tools: input.tools }),
  });
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

  return memoriesIn(pool).forgetAllOf({
    orgId: input.sfOrgRef,
    ...(input.sfUserRef !== undefined && { userId: input.sfUserRef }),
  });
}
