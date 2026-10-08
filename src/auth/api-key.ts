import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Formato da chave: `iris_<prefixo>_<segredo>`
 *   - prefixo: 8 hexadecimais, público, serve para localizar a chave na base de dados;
 *   - segredo: 32 bytes aleatórios em base64url (43 caracteres).
 *
 * Só se guarda o SHA-256 do segredo. Como o segredo tem 256 bits aleatórios, não é
 * preciso um hash lento (ao contrário de uma palavra-passe escolhida por uma pessoa).
 */
const KEY_PATTERN = /^iris_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  /** A chave completa. Mostra-se uma única vez e nunca se guarda. */
  key: string;
  prefix: string;
  secretHash: Buffer;
}

export interface ParsedApiKey {
  prefix: string;
  secretHash: Buffer;
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { key: `iris_${prefix}_${secret}`, prefix, secretHash: hashSecret(secret) };
}

export function parseApiKey(token: string): ParsedApiKey | undefined {
  const match = KEY_PATTERN.exec(token);
  const prefix = match?.[1];
  const secret = match?.[2];
  if (prefix === undefined || secret === undefined) return undefined;
  return { prefix, secretHash: hashSecret(secret) };
}

/** Comparação em tempo constante de dois hashes. */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
