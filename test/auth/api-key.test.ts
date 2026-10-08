import { describe, expect, it } from 'vitest';
import { generateApiKey, hashesEqual, hashSecret, parseApiKey } from '../../src/auth/api-key.js';

describe('chaves de API', () => {
  it('gera uma chave no formato iris_<8 hex>_<43 caracteres>', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^iris_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`iris_${prefix}_`)).toBe(true);
  });

  it('duas chaves nunca são iguais', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it('o que se lê da chave coincide com o que se guardou', () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.key);
    expect(parsed?.prefix).toBe(generated.prefix);
    expect(parsed && hashesEqual(parsed.secretHash, generated.secretHash)).toBe(true);
  });

  it('o hash guardado tem 32 bytes e não contém o segredo', () => {
    const { key, secretHash } = generateApiKey();
    expect(secretHash).toHaveLength(32);
    const secret = key.split('_').slice(2).join('_');
    expect(secretHash.toString('latin1')).not.toContain(secret);
  });

  it.each([
    ['vazia', ''],
    ['sem prefixo iris', 'abc_0123abcd_' + 'A'.repeat(43)],
    ['prefixo curto', 'iris_0123abc_' + 'A'.repeat(43)],
    ['prefixo com maiúsculas', 'iris_0123ABCD_' + 'A'.repeat(43)],
    ['segredo curto', 'iris_0123abcd_' + 'A'.repeat(42)],
    ['segredo comprido', 'iris_0123abcd_' + 'A'.repeat(44)],
    ['segredo com símbolos', 'iris_0123abcd_' + 'A'.repeat(42) + '!'],
    ['com espaço no fim', 'iris_0123abcd_' + 'A'.repeat(43) + ' '],
  ])('rejeita uma chave mal formada (%s)', (_label, token) => {
    expect(parseApiKey(token)).toBeUndefined();
  });

  it('hashes diferentes não são iguais, nem com tamanhos diferentes', () => {
    expect(hashesEqual(hashSecret('a'), hashSecret('b'))).toBe(false);
    expect(hashesEqual(hashSecret('a'), Buffer.alloc(3))).toBe(false);
    expect(hashesEqual(hashSecret('a'), hashSecret('a'))).toBe(true);
  });
});
