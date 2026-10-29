import { MAX_MEMORY_CHARS } from '../engine/memory.js';

/**
 * Validações dos dados que um administrador escreve. Cada função devolve a mensagem
 * de erro, ou `undefined` se o valor é válido. Servem o CLI e a interface de terminal,
 * para o utilizador ver o problema antes de a base de dados o recusar.
 */

const ORG_REF = /^00D[A-Za-z0-9]{15}$/;
const USER_REF = /^005[A-Za-z0-9]{15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Validator = (value: string) => string | undefined;

export const validateOrgRef: Validator = (v) =>
  ORG_REF.test(v) ? undefined : 'Id de org com 18 caracteres, a começar por 00D.';

export const validateUserRef: Validator = (v) =>
  USER_REF.test(v) ? undefined : 'Id de utilizador com 18 caracteres, a começar por 005.';

export const validateMemoryContent: Validator = (v) => {
  const text = v.trim();
  if (text === '') return 'O texto não pode estar vazio.';
  if (text.length > MAX_MEMORY_CHARS)
    return `No máximo ${String(MAX_MEMORY_CHARS)} caracteres (tem ${String(text.length)}).`;
  return undefined;
};

export const validateMemoryId: Validator = (v) =>
  UUID.test(v) ? undefined : 'Id de memória inválido (um UUID).';

/** A primeira falha de uma lista de verificações (campo, validador, valor), se houver. */
export function firstError(
  checks: (readonly [string, Validator, string])[],
): { field: string; message: string } | undefined {
  for (const [field, validator, value] of checks) {
    const message = validator(value);
    if (message !== undefined) return { field, message };
  }
  return undefined;
}
