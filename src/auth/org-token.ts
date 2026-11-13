import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tokens das orgs: JWT HS256 de curta duração, assinados com a chave da org.
 *
 * Quem chama gera um token por pedido e envia-o em `Authorization: Bearer <token>`. A IRIS
 * tira o `orgId` e o `userId` do token, depois de verificar a assinatura: deixam de vir no
 * corpo do pedido. A chave HMAC são os bytes UTF-8 do segredo, tal como foi entregue.
 *
 *   cabeçalho: { "alg": "HS256", "typ": "JWT", "kid": "k_…" }
 *   conteúdo:  { "iss": "00D…", "sub": "005…", "aud": "iris-engine",
 *                "iat": <s>, "exp": <s>, "jti": "<único>" }
 */

export const TOKEN_AUDIENCE = 'iris-engine';
/** Vida máxima de um token (`exp - iat`), em segundos. */
export const TOKEN_MAX_TTL_SECONDS = 300;
/** Tolerância aos relógios desacertados, em segundos. */
export const TOKEN_CLOCK_SKEW_SECONDS = 30;

const ORG_ID = /^00D[A-Za-z0-9]{15}$/;
const USER_ID = /^005[A-Za-z0-9]{15}$/;
const KID = /^k_[0-9a-f]{16}$/;
const JTI = /^[A-Za-z0-9._:-]{8,128}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Quem fez o pedido, provado pelo token. */
export interface Caller {
  orgId: string;
  userId: string;
}

/** Uma chave ativa de uma org. */
export interface OrgSigningKey {
  kid: string;
  orgId: string;
  secret: string;
}

/** Porque é que um token foi recusado. Só vai para o log, nunca para quem chama. */
export type TokenRejection =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_org'
  | 'bad_claims'
  | 'wrong_audience'
  | 'not_yet_valid'
  | 'expired'
  | 'ttl_too_long'
  | 'replayed';

export type TokenCheck =
  { ok: true; caller: Caller; kid: string } | { ok: false; reason: TokenRejection };

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function parseSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function signature(signingInput: string, secret: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(signingInput).digest();
}

/** Lê o `kid` sem verificar nada: só para saber que chave procurar. */
export function peekKid(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return undefined;
  const header = parseSegment(parts[0] ?? '');
  if (!isObject(header)) return undefined;
  const kid = header['kid'];
  return typeof kid === 'string' && KID.test(kid) ? kid : undefined;
}

/**
 * Verifica um token com a chave dada. `seen` diz se o `jti` já foi usado (e regista-o), para
 * recusar repetições. `now` em segundos.
 */
export function verifyOrgToken(
  token: string,
  key: OrgSigningKey | undefined,
  now: number,
  seen: (orgId: string, jti: string, exp: number) => boolean,
): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    return { ok: false, reason: 'malformed' };
  }
  const [h, p, s] = parts as [string, string, string];
  const header = parseSegment(h);
  const payload = parseSegment(p);
  if (!isObject(header) || !isObject(payload)) return { ok: false, reason: 'malformed' };
  // Só HS256: nunca deixar o token escolher o algoritmo (nem `none`).
  if (header['alg'] !== 'HS256') return { ok: false, reason: 'unsupported_alg' };
  if (header['typ'] !== undefined && header['typ'] !== 'JWT') {
    return { ok: false, reason: 'malformed' };
  }
  if (key === undefined || header['kid'] !== key.kid) return { ok: false, reason: 'unknown_key' };

  // A assinatura primeiro: sem ela, nada do conteúdo merece confiança.
  const expected = signature(`${h}.${p}`, key.secret);
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const { iss, sub, aud, iat, exp, jti } = payload;
  if (
    typeof iss !== 'string' ||
    !ORG_ID.test(iss) ||
    typeof sub !== 'string' ||
    !USER_ID.test(sub) ||
    !isTime(iat) ||
    !isTime(exp) ||
    typeof jti !== 'string' ||
    !JTI.test(jti)
  ) {
    return { ok: false, reason: 'bad_claims' };
  }
  // A chave é de uma org: não pode assinar pedidos em nome de outra.
  if (iss !== key.orgId) return { ok: false, reason: 'wrong_org' };
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(TOKEN_AUDIENCE)) return { ok: false, reason: 'wrong_audience' };
  if (exp <= iat || exp - iat > TOKEN_MAX_TTL_SECONDS) return { ok: false, reason: 'ttl_too_long' };
  if (iat > now + TOKEN_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet_valid' };
  if (exp <= now - TOKEN_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  if (seen(iss, jti, exp)) return { ok: false, reason: 'replayed' };

  return { ok: true, caller: { orgId: iss, userId: sub }, kid: key.kid };
}

/**
 * Gera um token. Serve aos testes, ao comando `admin sign-token` e de referência para quem
 * integra (o Apex faz o mesmo com `Crypto.generateMac('HmacSHA256', …)`).
 */
export function signOrgToken(
  key: OrgSigningKey,
  claims: {
    userId: string;
    jti: string;
    iat: number;
    ttlSeconds?: number;
    /** Só para testes: substitui campos do conteúdo. */
    override?: Record<string, unknown>;
    headerOverride?: Record<string, unknown>;
  },
): string {
  const header = b64url(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid, ...claims.headerOverride }),
  );
  const payload = b64url(
    JSON.stringify({
      iss: key.orgId,
      sub: claims.userId,
      aud: TOKEN_AUDIENCE,
      iat: claims.iat,
      exp: claims.iat + (claims.ttlSeconds ?? TOKEN_MAX_TTL_SECONDS),
      jti: claims.jti,
      ...claims.override,
    }),
  );
  return `${header}.${payload}.${b64url(signature(`${header}.${payload}`, key.secret))}`;
}
