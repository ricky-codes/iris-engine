import type { FastifyRequest } from 'fastify';
import { AppError } from '../http/errors.js';
import { hashesEqual, parseApiKey } from './api-key.js';
import type { CredentialRecord, CredentialStore } from './credential-store.js';

/** Quem está a chamar, depois de a chave ser validada. */
export interface AuthContext {
  apiCredentialId: string;
  tenant: CredentialRecord['tenant'];
  org: CredentialRecord['org'];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | undefined;
  }
}

/**
 * Motivos de recusa. Só vão para os logs: a resposta é sempre a mesma, para não
 * dizer a quem tenta adivinhar chaves o que correu mal.
 */
type Rejection =
  | 'missing_header'
  | 'bad_scheme'
  | 'malformed_key'
  | 'unknown_key'
  | 'wrong_secret'
  | 'revoked'
  | 'expired'
  | 'org_inactive'
  | 'tenant_inactive';

const BEARER = /^Bearer[ \t]+(\S+)$/i;
const UNUSED_HASH = Buffer.alloc(32);

function unauthorized(): AppError {
  return new AppError('unauthorized', 401, 'Credencial em falta ou inválida.', [], {
    'WWW-Authenticate': 'Bearer realm="iris"',
  });
}

async function verify(
  header: string | undefined,
  store: CredentialStore,
  now: Date,
): Promise<AuthContext | Rejection> {
  if (header === undefined || header === '') return 'missing_header';

  const bearer = BEARER.exec(header);
  const token = bearer?.[1];
  if (token === undefined) return 'bad_scheme';

  const parsed = parseApiKey(token);
  if (parsed === undefined) return 'malformed_key';

  const record = await store.findByPrefix(parsed.prefix);
  // Compara sempre um hash, mesmo sem registo, para o tempo de resposta não revelar
  // se o prefixo existe.
  const matches = hashesEqual(parsed.secretHash, record?.secretHash ?? UNUSED_HASH);
  if (record === undefined) return 'unknown_key';
  if (!matches) return 'wrong_secret';

  if (record.revokedAt !== null && record.revokedAt <= now) return 'revoked';
  if (record.expiresAt !== null && record.expiresAt <= now) return 'expired';
  if (!record.org.isActive) return 'org_inactive';
  if (!record.tenant.isActive) return 'tenant_inactive';

  return { apiCredentialId: record.apiCredentialId, tenant: record.tenant, org: record.org };
}

/**
 * Hook `onRequest` que exige uma chave válida. Corre antes de o corpo ser lido, por
 * isso um pedido sem credencial é recusado sem processar nada.
 */
export function createAuthenticator(store: CredentialStore, clock: () => Date = () => new Date()) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    let result: AuthContext | Rejection;
    try {
      result = await verify(request.headers.authorization, store, clock());
    } catch (err) {
      request.log.error({ err }, 'falha ao consultar credenciais');
      throw new AppError('service_unavailable', 503, 'Serviço temporariamente indisponível.');
    }

    if (typeof result === 'string') {
      request.log.info({ reason: result }, 'autenticação recusada');
      throw unauthorized();
    }
    request.auth = result;
  };
}

/** O contexto de autenticação de um pedido que passou por `authenticate`. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === undefined) {
    throw new AppError('internal_error', 500, 'Erro interno.');
  }
  return request.auth;
}

/**
 * O `orgId` que o Salesforce põe no corpo tem de ser o da org a que pertence a chave.
 * Aceita o id com 18 ou com 15 caracteres (o de 15 é o início do de 18).
 */
export function assertOrgMatches(auth: AuthContext, orgIdFromBody: string): void {
  const expected = auth.org.sfOrgRef;
  const matches =
    orgIdFromBody.length === 18
      ? orgIdFromBody === expected
      : orgIdFromBody.length === 15 && orgIdFromBody === expected.slice(0, 15);

  if (!matches) {
    throw new AppError('forbidden', 403, 'O orgId do pedido não corresponde à credencial.');
  }
}
