/**
 * Validações dos dados que um administrador escreve. Cada função devolve a mensagem
 * de erro, ou `undefined` se o valor é válido. Servem o CLI e a interface de terminal,
 * para o utilizador ver o problema antes de a base de dados o recusar.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ORG_REF = /^00D[A-Za-z0-9]{15}$/;
const USER_REF = /^005[A-Za-z0-9]{15}$/;
const KEY_PREFIX = /^[0-9a-f]{8}$/;
const HTTPS_URL = /^https:\/\/[^/\s]+\/?$/;

export type Validator = (value: string) => string | undefined;

export const validateSlug: Validator = (v) =>
  SLUG.test(v) ? undefined : 'Use minúsculas, números e hífenes (ex.: pingo-doce).';

export const validateName: Validator = (v) =>
  v.trim() === '' ? 'O nome não pode estar vazio.' : undefined;

export const validateOrgRef: Validator = (v) =>
  ORG_REF.test(v) ? undefined : 'Id de org com 18 caracteres, a começar por 00D.';

export const validateUserRef: Validator = (v) =>
  USER_REF.test(v) ? undefined : 'Id de utilizador com 18 caracteres, a começar por 005.';

export const validateInstanceUrl: Validator = (v) =>
  HTTPS_URL.test(v) ? undefined : 'URL https sem caminho (ex.: https://x.my.salesforce.com).';

export const validateKeyPrefix: Validator = (v) =>
  KEY_PREFIX.test(v) ? undefined : 'Prefixo com 8 hexadecimais (ex.: bac0000e).';

/** Campo opcional: vazio é válido; se preenchido, tem de ser um inteiro positivo. */
export const validateOptionalPositiveInt: Validator = (v) => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? undefined : 'Escreva um inteiro positivo, ou deixe vazio.';
};

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
