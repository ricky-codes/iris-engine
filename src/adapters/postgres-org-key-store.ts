import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { OrgKeyInfo, OrgKeyStore } from '../auth/org-keys.js';
import type { OrgSigningKey } from '../auth/org-token.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Cifra os segredos das orgs com AES-256-GCM. A chave mestra vem do `.env` (32 bytes). */
export class SecretBox {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('A chave mestra tem de ter 32 bytes.');
  }

  seal(plain: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  open(sealed: Buffer): string {
    const iv = sealed.subarray(0, IV_BYTES);
    const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}

interface Row {
  org_key_id: string;
  sf_org_ref: string;
  label: string | null;
  created_at: Date;
  created_by: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
}

const COLUMNS =
  'org_key_id, sf_org_ref, label, created_at, created_by, revoked_at, revoked_by, last_used_at';

const info = (r: Row): OrgKeyInfo => ({
  kid: r.org_key_id,
  orgId: r.sf_org_ref,
  label: r.label,
  status: r.revoked_at === null ? 'active' : 'revoked',
  createdAt: r.created_at,
  createdBy: r.created_by,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
  lastUsedAt: r.last_used_at,
});

/** As chaves das orgs na tabela `org_key` (migração 0013). */
export class PgOrgKeyStore implements OrgKeyStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly box: SecretBox,
  ) {}

  async findActive(kid: string): Promise<OrgSigningKey | undefined> {
    const { rows } = await this.pool.query<{ sf_org_ref: string; secret_enc: Buffer }>(
      'SELECT sf_org_ref, secret_enc FROM org_key WHERE org_key_id = $1 AND revoked_at IS NULL',
      [kid],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { kid, orgId: row.sf_org_ref, secret: this.box.open(row.secret_enc) };
  }

  async insert(
    key: OrgSigningKey,
    actor: string,
    maxActive: number,
    label: string | null,
  ): Promise<OrgKeyInfo | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Uma org de cada vez: o limite de chaves ativas não se fura com pedidos simultâneos.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`org_key:${key.orgId}`]);
      const { rows: count } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM org_key WHERE sf_org_ref = $1 AND revoked_at IS NULL',
        [key.orgId],
      );
      if ((count[0]?.n ?? 0) >= maxActive) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const { rows } = await client.query<Row>(
        `INSERT INTO org_key (org_key_id, sf_org_ref, secret_enc, created_by, label)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [key.kid, key.orgId, this.box.seal(key.secret), actor, label],
      );
      await client.query('COMMIT');
      return rows[0] === undefined ? undefined : info(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(orgId: string): Promise<OrgKeyInfo[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM org_key WHERE sf_org_ref = $1
       ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      [orgId],
    );
    return rows.map(info);
  }

  async setLabel(
    orgId: string,
    kid: string,
    label: string | null,
  ): Promise<OrgKeyInfo | undefined> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE org_key SET label = $3 WHERE org_key_id = $1 AND sf_org_ref = $2 RETURNING ${COLUMNS}`,
      [kid, orgId, label],
    );
    return rows[0] === undefined ? undefined : info(rows[0]);
  }

  async touch(kid: string): Promise<void> {
    await this.pool.query('UPDATE org_key SET last_used_at = now() WHERE org_key_id = $1', [kid]);
  }

  async revoke(orgId: string, kid: string, actor: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE org_key SET revoked_at = now(), revoked_by = $3
       WHERE org_key_id = $1 AND sf_org_ref = $2 AND revoked_at IS NULL`,
      [kid, orgId, actor],
    );
    return rowCount === 1;
  }
}
