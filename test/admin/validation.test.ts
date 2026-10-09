import { describe, expect, it } from 'vitest';
import {
  validateInstanceUrl,
  validateKeyPrefix,
  validateName,
  validateOptionalPositiveInt,
  validateOrgRef,
  validateSlug,
  validateUserRef,
} from '../../src/admin/validation.js';

describe('validações de administração', () => {
  it.each([
    [validateSlug, 'pingo-doce', true],
    [validateSlug, 'iris-dev', true],
    [validateSlug, 'a1', true],
    [validateSlug, 'Pingo-Doce', false],
    [validateSlug, 'pingo doce', false],
    [validateSlug, '-pingo', false],
    [validateSlug, 'pingo--doce', false],
    [validateSlug, '', false],
    [validateName, 'Pingo Doce', true],
    [validateName, '   ', false],
    [validateOrgRef, '00DgL00000O7vLVUAZ', true],
    [validateOrgRef, '00DgL00000O7vLV', false],
    [validateOrgRef, '005gL00000GpOQTQA3', false],
    [validateUserRef, '005gL00000GpOQTQA3', true],
    [validateUserRef, '00DgL00000O7vLVUAZ', false],
    [validateUserRef, '005gL00000GpOQT', false],
    [validateInstanceUrl, 'https://x.my.salesforce.com', true],
    [validateInstanceUrl, 'https://x.my.salesforce.com/', true],
    [validateInstanceUrl, 'http://x.my.salesforce.com', false],
    [validateInstanceUrl, 'https://x.my.salesforce.com/lightning', false],
    [validateInstanceUrl, 'x.my.salesforce.com', false],
    [validateKeyPrefix, 'bac0000e', true],
    [validateKeyPrefix, 'BAC0000E', false],
    [validateKeyPrefix, 'bac0000', false],
    [validateOptionalPositiveInt, '', true],
    [validateOptionalPositiveInt, '30', true],
    [validateOptionalPositiveInt, '0', false],
    [validateOptionalPositiveInt, '-5', false],
    [validateOptionalPositiveInt, '1.5', false],
    [validateOptionalPositiveInt, 'abc', false],
  ] as const)('%o(%j) -> válido: %s', (validator, value, valid) => {
    expect(validator(value) === undefined).toBe(valid);
  });

  it('devolve uma mensagem legível quando é inválido', () => {
    expect(validateSlug('X Y')).toMatch(/minúsculas/);
    expect(validateOrgRef('x')).toMatch(/00D/);
  });
});
