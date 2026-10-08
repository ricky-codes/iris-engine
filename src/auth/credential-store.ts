import type { Pool } from 'pg';

export interface CredentialRecord {
  apiCredentialId: string;
  keyPrefix: string;
  secretHash: Buffer;
  expiresAt: Date | null;
  revokedAt: Date | null;
  org: { sfOrgId: string; sfOrgRef: string; isSandbox: boolean; isActive: boolean };
  tenant: { tenantId: string; slug: string; name: string; isActive: boolean };
}

/** Onde se procuram as credenciais. Uma interface para os testes não precisarem de base de dados. */
export interface CredentialStore {
  findByPrefix(prefix: string): Promise<CredentialRecord | undefined>;
}

interface CredentialRow {
  api_credential_id: string;
  key_prefix: string;
  secret_hash: Buffer;
  expires_at: Date | null;
  revoked_at: Date | null;
  sf_org_id: string;
  sf_org_ref: string;
  is_sandbox: boolean;
  org_active: boolean;
  tenant_id: string;
  slug: string;
  name: string;
  tenant_active: boolean;
}

export class PgCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async findByPrefix(prefix: string): Promise<CredentialRecord | undefined> {
    const { rows } = await this.pool.query<CredentialRow>(
      `SELECT c.api_credential_id, c.key_prefix, c.secret_hash, c.expires_at, c.revoked_at,
              o.sf_org_id, o.sf_org_ref, o.is_sandbox, o.is_active AS org_active,
              t.tenant_id, t.slug, t.name, t.is_active AS tenant_active
       FROM api_credential c
       JOIN sf_org o ON o.sf_org_id = c.sf_org_id
       JOIN tenant t ON t.tenant_id = o.tenant_id
       WHERE c.key_prefix = $1`,
      [prefix],
    );
    const row = rows[0];
    if (row === undefined) return undefined;

    return {
      apiCredentialId: row.api_credential_id,
      keyPrefix: row.key_prefix,
      secretHash: row.secret_hash,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      org: {
        sfOrgId: row.sf_org_id,
        sfOrgRef: row.sf_org_ref,
        isSandbox: row.is_sandbox,
        isActive: row.org_active,
      },
      tenant: {
        tenantId: row.tenant_id,
        slug: row.slug,
        name: row.name,
        isActive: row.tenant_active,
      },
    };
  }
}
