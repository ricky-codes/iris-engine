import { describe, expect, it } from 'vitest';
import {
  validateMemoryContent,
  validateMemoryId,
  validateOrgRef,
  validateUserRef,
} from '../../src/admin/validation.js';

describe('validações de administração', () => {
  it.each([
    [validateOrgRef, '00DgL00000O7vLVUAZ', true],
    [validateOrgRef, '00DgL00000O7vLV', false],
    [validateOrgRef, '005gL00000GpOQTQA3', false],
    [validateUserRef, '005gL00000GpOQTQA3', true],
    [validateUserRef, '00DgL00000O7vLVUAZ', false],
    [validateUserRef, '005gL00000GpOQT', false],
    [validateMemoryContent, 'Tratar sempre o cliente por você.', true],
    [validateMemoryContent, 'x'.repeat(500), true],
    [validateMemoryContent, 'x'.repeat(501), false],
    [validateMemoryContent, '   ', false],
    [validateMemoryId, '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b', true],
    [validateMemoryId, 'm-1', false],
  ] as const)('%o(%j) -> válido: %s', (validator, value, valid) => {
    expect(validator(value) === undefined).toBe(valid);
  });

  it('devolve uma mensagem legível quando é inválido', () => {
    expect(validateOrgRef('x')).toMatch(/00D/);
    expect(validateMemoryContent('x'.repeat(501))).toMatch(/500/);
  });
});
