import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Caller, TokenCheck } from '../auth/org-token.js';
import { markReason, markStage, type AuthFailureReason } from '../engine/pipeline.js';
import { AppError } from './errors.js';

/** Quem verifica os tokens das orgs (ver src/auth/org-keys.ts). */
export interface TokenVerifier {
  verify(token: string): Promise<TokenCheck>;
}

/**
 * Como as rotas públicas (`/v1/tools`, `/v1/memories`) autenticam quem chama:
 *
 * - `orgKeys`: token assinado com a chave da org. O `orgId` e o `userId` vêm do token e não
 *   podem vir no pedido.
 * - `apiSecret`: segredo único partilhado (modo antigo). O `orgId` e o `userId` vêm no pedido
 *   e a IRIS confia neles.
 */
export type PublicAuth =
  { orgKeys: TokenVerifier; apiSecret?: undefined } | { apiSecret: string; orgKeys?: undefined };

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compara em tempo constante (os hashes têm sempre o mesmo tamanho). */
function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

export const unauthorized = (): AppError =>
  new AppError('unauthorized', 401, 'Credenciais inválidas.', [], {
    'WWW-Authenticate': 'Bearer',
  });

/** O 401 de sempre, marcado com o passo `auth` e a razão (só para as métricas, nunca para quem chama). */
const rejected = (reason: AuthFailureReason): unknown =>
  markStage(markReason(unauthorized(), reason), 'auth');

const bearerOf = (request: FastifyRequest): string | undefined =>
  /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

/** Exige `Authorization: Bearer <segredo>`. Corre antes de se ler o corpo. */
export function bearerAuth(secret: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const given = bearerOf(request);
    if (given === undefined) throw rejected('auth_missing');
    if (!secretMatches(given, secret)) throw rejected('auth_bad_secret');
  };
}

const callers = new WeakMap<FastifyRequest, Caller>();

/**
 * Autentica as rotas públicas, antes de se ler o corpo. Com tokens, guarda quem chama
 * (ver `callerOf`). A razão de uma recusa vai só para o log.
 */
export function publicAuth(auth: PublicAuth) {
  if (auth.orgKeys === undefined) return bearerAuth(auth.apiSecret);
  const verifier = auth.orgKeys;
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearerOf(request);
    if (token === undefined) throw rejected('auth_missing');
    const check = await verifier.verify(token);
    if (!check.ok) {
      request.log.info({ reason: check.reason }, 'token recusado');
      throw rejected(`token_${check.reason}`);
    }
    callers.set(request, check.caller);
  };
}

/** Quem chama, provado pelo token. `undefined` no modo do segredo partilhado. */
export const callerOf = (request: FastifyRequest): Caller | undefined => callers.get(request);

/** Com tokens, os ids saem do token; com o segredo partilhado, do pedido. */
export function ownerOf(
  request: FastifyRequest,
  declared: { orgId?: string; userId?: string },
): Caller {
  const caller = callerOf(request);
  if (caller !== undefined) return caller;
  if (declared.orgId === undefined || declared.userId === undefined) throw unauthorized();
  return { orgId: declared.orgId, userId: declared.userId };
}
