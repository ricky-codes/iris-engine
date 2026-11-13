import { describe, expect, it } from 'vitest';
import {
  OrgKeyError,
  OrgKeys,
  type OrgKeyInfo,
  type OrgKeyStore,
} from '../../src/auth/org-keys.js';
import { signOrgToken, verifyOrgToken, type OrgSigningKey } from '../../src/auth/org-token.js';

const ORG = '00DAAAAAAAAAAAAAAA';
const OTHER_ORG = '00DBBBBBBBBBBBBBBB';
const USER = '005AAAAAAAAAAAAAAA';
const KEY: OrgSigningKey = {
  kid: 'k_0123456789abcdef',
  orgId: ORG,
  secret: 'segredo-da-org-1234567890',
};
const NOW = 1_800_000_000;
const never = () => false;

const token = (
  over: Parameters<typeof signOrgToken>[1] extends infer C ? Partial<C> : never = {},
) => signOrgToken(KEY, { userId: USER, jti: 'pedido-0001', iat: NOW, ttlSeconds: 60, ...over });

describe('verifyOrgToken', () => {
  it('aceita um token válido e tira dele a org e o utilizador', () => {
    expect(verifyOrgToken(token(), KEY, NOW, never)).toEqual({
      ok: true,
      caller: { orgId: ORG, userId: USER },
      kid: KEY.kid,
    });
  });

  it.each([
    ['não é um JWT', 'abc', 'malformed'],
    ['quatro partes', `${token()}.x`, 'malformed'],
  ])('recusa: %s', (_l, t, reason) => {
    expect(verifyOrgToken(t, KEY, NOW, never)).toEqual({ ok: false, reason });
  });

  it('recusa outro algoritmo, incluindo "none"', () => {
    for (const alg of ['none', 'HS512', 'RS256']) {
      const t = token({ headerOverride: { alg } });
      expect(verifyOrgToken(t, KEY, NOW, never)).toEqual({ ok: false, reason: 'unsupported_alg' });
    }
  });

  it('recusa sem chave conhecida ou com outro kid', () => {
    expect(verifyOrgToken(token(), undefined, NOW, never)).toMatchObject({ reason: 'unknown_key' });
    const t = token({ headerOverride: { kid: 'k_ffffffffffffffff' } });
    expect(verifyOrgToken(t, KEY, NOW, never)).toMatchObject({ reason: 'unknown_key' });
  });

  it('recusa uma assinatura feita com outro segredo ou um conteúdo alterado', () => {
    const forged = signOrgToken(
      { ...KEY, secret: 'outro-segredo' },
      { userId: USER, jti: 'pedido-0001', iat: NOW, ttlSeconds: 60 },
    );
    expect(verifyOrgToken(forged, KEY, NOW, never)).toMatchObject({ reason: 'bad_signature' });

    const [h, , s] = token().split('.');
    const payload = Buffer.from(
      JSON.stringify({
        iss: ORG,
        sub: '005BBBBBBBBBBBBBBB',
        aud: 'iris-engine',
        iat: NOW,
        exp: NOW + 60,
        jti: 'pedido-0001',
      }),
    ).toString('base64url');
    expect(verifyOrgToken(`${h}.${payload}.${s}`, KEY, NOW, never)).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('a chave de uma org não assina em nome de outra', () => {
    const t = token({ override: { iss: OTHER_ORG } });
    expect(verifyOrgToken(t, KEY, NOW, never)).toMatchObject({ reason: 'wrong_org' });
  });

  it.each([
    ['userId inválido', { sub: 'nao-e-um-id' }, 'bad_claims'],
    ['sem jti', { jti: undefined }, 'bad_claims'],
    ['outra audiência', { aud: 'outro-servico' }, 'wrong_audience'],
  ])('recusa: %s', (_l, override, reason) => {
    expect(verifyOrgToken(token({ override }), KEY, NOW, never)).toMatchObject({ reason });
  });

  it('aceita a audiência numa lista', () => {
    const t = token({ override: { aud: ['outro', 'iris-engine'] } });
    expect(verifyOrgToken(t, KEY, NOW, never)).toMatchObject({ ok: true });
  });

  it('controla o tempo: vida máxima de 5 minutos, expirado, emitido no futuro', () => {
    expect(verifyOrgToken(token({ ttlSeconds: 301 }), KEY, NOW, never)).toMatchObject({
      reason: 'ttl_too_long',
    });
    expect(verifyOrgToken(token(), KEY, NOW + 91, never)).toMatchObject({ reason: 'expired' });
    // 30 s de tolerância aos relógios.
    expect(verifyOrgToken(token(), KEY, NOW + 89, never)).toMatchObject({ ok: true });
    expect(verifyOrgToken(token(), KEY, NOW - 31, never)).toMatchObject({
      reason: 'not_yet_valid',
    });
    expect(verifyOrgToken(token(), KEY, NOW - 29, never)).toMatchObject({ ok: true });
  });

  it('recusa um token repetido', () => {
    expect(verifyOrgToken(token(), KEY, NOW, () => true)).toMatchObject({ reason: 'replayed' });
  });
});

/** Chaves em memória, contando as leituras. */
function memoryStore() {
  const keys = new Map<string, OrgSigningKey & { revoked: boolean }>();
  let reads = 0;
  const touched: string[] = [];
  const store: OrgKeyStore = {
    findActive: async (kid) => {
      reads++;
      const k = keys.get(kid);
      return k === undefined || k.revoked
        ? undefined
        : { kid: k.kid, orgId: k.orgId, secret: k.secret };
    },
    insert: async (key, actor, maxActive) => {
      const active = [...keys.values()].filter((k) => k.orgId === key.orgId && !k.revoked);
      if (active.length >= maxActive) return undefined;
      keys.set(key.kid, { ...key, revoked: false });
      const info: OrgKeyInfo = {
        kid: key.kid,
        orgId: key.orgId,
        label: null,
        status: 'active',
        createdAt: new Date(),
        createdBy: actor,
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: null,
      };
      return info;
    },
    list: async () => [],
    setLabel: async () => undefined,
    touch: async (kid) => {
      touched.push(kid);
    },
    revoke: async (orgId, kid) => {
      const k = keys.get(kid);
      if (k === undefined || k.orgId !== orgId || k.revoked) return false;
      k.revoked = true;
      return true;
    },
  };
  return { store, reads: () => reads, touched };
}

describe('OrgKeys', () => {
  it('cria uma chave cujo segredo assina tokens válidos', async () => {
    const now = NOW * 1000;
    const { store } = memoryStore();
    const keys = new OrgKeys(store, () => now);
    const created = await keys.create(ORG, 'admin@step');
    expect(created.kid).toMatch(/^k_[0-9a-f]{16}$/);
    expect(created.secret.length).toBeGreaterThanOrEqual(43);

    const t = signOrgToken(created, { userId: USER, jti: 'pedido-0001', iat: NOW });
    expect(await keys.verify(t)).toMatchObject({ ok: true, caller: { orgId: ORG, userId: USER } });
    // O mesmo token outra vez: recusado.
    expect(await keys.verify(t)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('no máximo duas chaves ativas por org', async () => {
    const keys = new OrgKeys(memoryStore().store);
    await keys.create(ORG, 'a');
    const second = await keys.create(ORG, 'a');
    await expect(keys.create(ORG, 'a')).rejects.toBeInstanceOf(OrgKeyError);
    await keys.revoke(ORG, second.kid, 'a');
    await expect(keys.create(ORG, 'a')).resolves.toMatchObject({ orgId: ORG });
    // Noutra org não conta.
    await expect(keys.create(OTHER_ORG, 'a')).resolves.toMatchObject({ orgId: OTHER_ORG });
  });

  it('guarda as chaves em cache e a revogação vale já nesta instância', async () => {
    const { store, reads } = memoryStore();
    const keys = new OrgKeys(store, () => NOW * 1000);
    const k = await keys.create(ORG, 'a');
    const sign = (jti: string) => signOrgToken(k, { userId: USER, jti, iat: NOW });

    expect(await keys.verify(sign('pedido-0001'))).toMatchObject({ ok: true });
    expect(await keys.verify(sign('pedido-0002'))).toMatchObject({ ok: true });
    expect(reads()).toBe(1);

    await keys.revoke(ORG, k.kid, 'a');
    expect(await keys.verify(sign('pedido-0003'))).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('não revoga a chave de outra org', async () => {
    const keys = new OrgKeys(memoryStore().store);
    const k = await keys.create(ORG, 'a');
    await expect(keys.revoke(OTHER_ORG, k.kid, 'a')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('grava o último uso no máximo uma vez por minuto por chave, e só com tokens aceites', async () => {
    let now = NOW * 1000;
    const { store, touched } = memoryStore();
    const keys = new OrgKeys(store, () => now);
    const k = await keys.create(ORG, 'a');
    const sign = (jti: string) =>
      signOrgToken(k, { userId: USER, jti, iat: Math.floor(now / 1000) });

    await keys.verify(sign('pedido-0001'));
    await keys.verify(sign('pedido-0002'));
    expect(touched).toEqual([k.kid]);
    // Um token recusado não conta como uso.
    await keys.verify(sign('pedido-0002'));
    expect(touched).toHaveLength(1);

    now += 61_000;
    await keys.verify(sign('pedido-0003'));
    expect(touched).toEqual([k.kid, k.kid]);
  });
});
