import type { Pool } from 'pg';
import { generateApiKey } from '../auth/api-key.js';
import {
  firstError,
  validateInstanceUrl,
  validateName,
  validateOrgRef,
  validateSlug,
  validateUserRef,
} from './validation.js';

/**
 * Operações de administração: criar clientes, orgs e chaves. Corre-se a partir do
 * terminal (src/admin/cli.ts); não há API de administração.
 */

/** Máximo de chaves ativas ao mesmo tempo por org: a que está em uso e a que a vai substituir. */
export const MAX_ACTIVE_KEYS_PER_ORG = 2;

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

const UNIQUE_VIOLATION = '23505';
const isPgError = (err: unknown, code: string): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

export async function createTenant(
  pool: Pool,
  input: { slug: string; name: string; retentionDays?: number },
): Promise<{ tenantId: string }> {
  const invalid = firstError([
    ['slug', validateSlug, input.slug],
    ['nome', validateName, input.name],
  ]);
  if (invalid) throw new AdminError(`${invalid.field}: ${invalid.message}`);

  try {
    const { rows } = await pool.query<{ tenant_id: string }>(
      `INSERT INTO tenant (slug, name, result_retention_days)
       VALUES ($1, $2, COALESCE($3, 30)) RETURNING tenant_id`,
      [input.slug, input.name, input.retentionDays ?? null],
    );
    return { tenantId: rows[0]?.tenant_id ?? '' };
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION))
      throw new AdminError(`Já existe o cliente "${input.slug}".`);
    throw err;
  }
}

export async function createOrg(
  pool: Pool,
  input: { tenantSlug: string; sfOrgRef: string; instanceUrl: string; isSandbox: boolean },
): Promise<{ sfOrgId: string }> {
  const invalid = firstError([
    ['org-id', validateOrgRef, input.sfOrgRef],
    ['instance-url', validateInstanceUrl, input.instanceUrl],
  ]);
  if (invalid) throw new AdminError(`${invalid.field}: ${invalid.message}`);

  const tenant = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenant WHERE slug = $1',
    [input.tenantSlug],
  );
  const tenantId = tenant.rows[0]?.tenant_id;
  if (tenantId === undefined) throw new AdminError(`O cliente "${input.tenantSlug}" não existe.`);

  try {
    const { rows } = await pool.query<{ sf_org_id: string }>(
      `INSERT INTO sf_org (tenant_id, sf_org_ref, instance_url, is_sandbox)
       VALUES ($1, $2, $3, $4) RETURNING sf_org_id`,
      [tenantId, input.sfOrgRef, input.instanceUrl.replace(/\/+$/, ''), input.isSandbox],
    );
    return { sfOrgId: rows[0]?.sf_org_id ?? '' };
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) {
      throw new AdminError(`A org ${input.sfOrgRef} já está registada.`);
    }
    throw err;
  }
}

export interface CreatedKey {
  /** A chave completa. É a única vez que existe em claro. */
  key: string;
  keyPrefix: string;
  expiresAt: Date | null;
}

export async function createApiKey(
  pool: Pool,
  input: { sfOrgRef: string; expiresInDays?: number; now?: Date },
): Promise<CreatedKey> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bloqueia a org para duas criações em simultâneo não furarem o limite de chaves ativas.
    const org = await client.query<{ sf_org_id: string }>(
      'SELECT sf_org_id FROM sf_org WHERE sf_org_ref = $1 FOR UPDATE',
      [input.sfOrgRef],
    );
    const sfOrgId = org.rows[0]?.sf_org_id;
    if (sfOrgId === undefined) throw new AdminError(`A org ${input.sfOrgRef} não existe.`);

    const now = input.now ?? new Date();
    const active = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_credential
       WHERE sf_org_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [sfOrgId, now],
    );
    if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_KEYS_PER_ORG) {
      throw new AdminError(
        `A org ${input.sfOrgRef} já tem ${MAX_ACTIVE_KEYS_PER_ORG} chaves ativas. Revogue uma antes de criar outra.`,
      );
    }

    const expiresAt =
      input.expiresInDays === undefined
        ? null
        : new Date(now.getTime() + input.expiresInDays * 86_400_000);

    // O prefixo tem 32 bits e é único: na improvável colisão, tenta-se com outra chave.
    for (let attempt = 0; attempt < 5; attempt++) {
      const generated = generateApiKey();
      await client.query('SAVEPOINT insert_key');
      try {
        await client.query(
          `INSERT INTO api_credential (sf_org_id, key_prefix, secret_hash, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [sfOrgId, generated.prefix, generated.secretHash, now, expiresAt],
        );
        await client.query('COMMIT');
        return { key: generated.key, keyPrefix: generated.prefix, expiresAt };
      } catch (err) {
        if (!isPgError(err, UNIQUE_VIOLATION)) throw err;
        await client.query('ROLLBACK TO SAVEPOINT insert_key');
      }
    }
    throw new AdminError('Não foi possível gerar um prefixo de chave único. Tente de novo.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Revoga uma chave pelo prefixo. Devolve falso se não existe ou já estava revogada. */
export async function revokeApiKey(
  pool: Pool,
  input: { keyPrefix: string; now?: Date },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE api_credential SET revoked_at = GREATEST($2::timestamptz, created_at)
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [input.keyPrefix, input.now ?? new Date()],
  );
  return rowCount === 1;
}

export interface KeySummary {
  tenant: string;
  org: string;
  isSandbox: boolean;
  keyPrefix: string;
  status: 'ativa' | 'revogada' | 'expirada';
  createdAt: Date;
  expiresAt: Date | null;
}

/** Lista as chaves de todas as orgs. Nunca devolve segredos nem hashes. */
export async function listKeys(pool: Pool, now: Date = new Date()): Promise<KeySummary[]> {
  const { rows } = await pool.query<{
    slug: string;
    sf_org_ref: string;
    is_sandbox: boolean;
    key_prefix: string;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT t.slug, o.sf_org_ref, o.is_sandbox, c.key_prefix, c.created_at, c.expires_at, c.revoked_at
     FROM api_credential c
     JOIN sf_org o ON o.sf_org_id = c.sf_org_id
     JOIN tenant t ON t.tenant_id = o.tenant_id
     ORDER BY t.slug, o.sf_org_ref, c.created_at`,
  );
  return rows.map((r) => ({
    tenant: r.slug,
    org: r.sf_org_ref,
    isSandbox: r.is_sandbox,
    keyPrefix: r.key_prefix,
    status:
      r.revoked_at !== null && r.revoked_at <= now
        ? 'revogada'
        : r.expires_at !== null && r.expires_at <= now
          ? 'expirada'
          : 'ativa',
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** Ativa ou desativa um cliente. Com o cliente desativado, todas as chaves das suas orgs são recusadas. */
export async function setTenantActive(
  pool: Pool,
  input: { slug: string; isActive: boolean },
): Promise<void> {
  const { rowCount } = await pool.query('UPDATE tenant SET is_active = $2 WHERE slug = $1', [
    input.slug,
    input.isActive,
  ]);
  if (rowCount !== 1) throw new AdminError(`O cliente "${input.slug}" não existe.`);
}

/** Ativa ou desativa uma org. Com a org desativada, as suas chaves são recusadas. */
export async function setOrgActive(
  pool: Pool,
  input: { sfOrgRef: string; isActive: boolean },
): Promise<void> {
  const { rowCount } = await pool.query('UPDATE sf_org SET is_active = $2 WHERE sf_org_ref = $1', [
    input.sfOrgRef,
    input.isActive,
  ]);
  if (rowCount !== 1) throw new AdminError(`A org ${input.sfOrgRef} não existe.`);
}

/**
 * Cria um utilizador numa org antes de ele fazer o primeiro pedido. Normalmente não é
 * preciso: o utilizador é criado sozinho no primeiro pedido.
 */
export async function createOrgUser(
  pool: Pool,
  input: { sfOrgRef: string; sfUserRef: string },
): Promise<{ orgUserId: string }> {
  const invalid = firstError([
    ['org-id', validateOrgRef, input.sfOrgRef],
    ['user-id', validateUserRef, input.sfUserRef],
  ]);
  if (invalid) throw new AdminError(`${invalid.field}: ${invalid.message}`);

  const org = await pool.query<{ sf_org_id: string }>(
    'SELECT sf_org_id FROM sf_org WHERE sf_org_ref = $1',
    [input.sfOrgRef],
  );
  const sfOrgId = org.rows[0]?.sf_org_id;
  if (sfOrgId === undefined) throw new AdminError(`A org ${input.sfOrgRef} não existe.`);

  try {
    const { rows } = await pool.query<{ org_user_id: string }>(
      'INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2) RETURNING org_user_id',
      [sfOrgId, input.sfUserRef],
    );
    return { orgUserId: rows[0]?.org_user_id ?? '' };
  } catch (err) {
    if (isPgError(err, UNIQUE_VIOLATION)) {
      throw new AdminError(`O utilizador ${input.sfUserRef} já existe na org ${input.sfOrgRef}.`);
    }
    throw err;
  }
}

export interface UserDeletionPreview {
  requests: number;
  memories: number;
}

/** O que desaparece se o utilizador for apagado: pedidos (com resultados) e memórias dele. */
export async function previewUserDeletion(
  pool: Pool,
  input: { orgUserId: string },
): Promise<UserDeletionPreview> {
  const { rows } = await pool.query<{ requests: number; memories: number }>(
    `SELECT (SELECT count(*) FROM inference_request WHERE org_user_id = $1)::int AS requests,
            (SELECT count(*) FROM org_user_memory WHERE org_user_id = $1)::int AS memories`,
    [input.orgUserId],
  );
  return rows[0] ?? { requests: 0, memories: 0 };
}

/** Apaga um utilizador e, em cascata, os pedidos, resultados e memórias dele (direito ao apagamento). */
export async function deleteOrgUser(pool: Pool, input: { orgUserId: string }): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM org_user WHERE org_user_id = $1', [
    input.orgUserId,
  ]);
  if (rowCount !== 1) throw new AdminError('O utilizador já não existe.');
}
