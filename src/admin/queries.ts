import type { Pool } from 'pg';
import type { KeySummary } from './commands.js';

export interface TenantRow {
  tenantId: string;
  slug: string;
  name: string;
  isActive: boolean;
  retentionDays: number;
  orgCount: number;
  createdAt: Date;
}

export interface OrgRow {
  sfOrgId: string;
  sfOrgRef: string;
  tenantSlug: string;
  instanceUrl: string;
  isSandbox: boolean;
  isActive: boolean;
  userCount: number;
  createdAt: Date;
}

export interface UserRow {
  orgUserId: string;
  sfUserRef: string;
  sfOrgRef: string;
  tenantSlug: string;
  firstSeenAt: Date;
  requestCount: number;
  memoryCount: number;
}

export async function listTenants(pool: Pool): Promise<TenantRow[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    slug: string;
    name: string;
    is_active: boolean;
    result_retention_days: number;
    org_count: number;
    created_at: Date;
  }>(
    `SELECT t.tenant_id, t.slug, t.name, t.is_active, t.result_retention_days, t.created_at,
            (SELECT count(*) FROM sf_org o WHERE o.tenant_id = t.tenant_id)::int AS org_count
     FROM tenant t ORDER BY t.slug`,
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    slug: r.slug,
    name: r.name,
    isActive: r.is_active,
    retentionDays: r.result_retention_days,
    orgCount: r.org_count,
    createdAt: r.created_at,
  }));
}

export async function listOrgs(pool: Pool): Promise<OrgRow[]> {
  const { rows } = await pool.query<{
    sf_org_id: string;
    sf_org_ref: string;
    slug: string;
    instance_url: string;
    is_sandbox: boolean;
    is_active: boolean;
    user_count: number;
    created_at: Date;
  }>(
    `SELECT o.sf_org_id, o.sf_org_ref, t.slug, o.instance_url, o.is_sandbox, o.is_active, o.created_at,
            (SELECT count(*) FROM org_user u WHERE u.sf_org_id = o.sf_org_id)::int AS user_count
     FROM sf_org o JOIN tenant t ON t.tenant_id = o.tenant_id
     ORDER BY t.slug, o.sf_org_ref`,
  );
  return rows.map((r) => ({
    sfOrgId: r.sf_org_id,
    sfOrgRef: r.sf_org_ref,
    tenantSlug: r.slug,
    instanceUrl: r.instance_url,
    isSandbox: r.is_sandbox,
    isActive: r.is_active,
    userCount: r.user_count,
    createdAt: r.created_at,
  }));
}

export async function listUsers(pool: Pool): Promise<UserRow[]> {
  const { rows } = await pool.query<{
    org_user_id: string;
    sf_user_ref: string;
    sf_org_ref: string;
    slug: string;
    first_seen_at: Date;
    request_count: number;
    memory_count: number;
  }>(
    `SELECT u.org_user_id, u.sf_user_ref, o.sf_org_ref, t.slug, u.first_seen_at,
            (SELECT count(*) FROM inference_request r WHERE r.org_user_id = u.org_user_id)::int AS request_count,
            (SELECT count(*) FROM org_user_memory m WHERE m.org_user_id = u.org_user_id)::int AS memory_count
     FROM org_user u
     JOIN sf_org o ON o.sf_org_id = u.sf_org_id
     JOIN tenant t ON t.tenant_id = o.tenant_id
     ORDER BY t.slug, o.sf_org_ref, u.first_seen_at, u.sf_user_ref`,
  );
  return rows.map((r) => ({
    orgUserId: r.org_user_id,
    sfUserRef: r.sf_user_ref,
    sfOrgRef: r.sf_org_ref,
    tenantSlug: r.slug,
    firstSeenAt: r.first_seen_at,
    requestCount: r.request_count,
    memoryCount: r.memory_count,
  }));
}

/** Tudo o que a interface mostra, carregado de uma vez (são listas pequenas). */
export interface AdminData {
  tenants: TenantRow[];
  orgs: OrgRow[];
  users: UserRow[];
  keys: KeySummary[];
}

export interface OrgNode {
  org: OrgRow;
  users: UserRow[];
  keys: KeySummary[];
}

export interface TenantNode {
  tenant: TenantRow;
  orgs: OrgNode[];
}

/** Liga clientes → orgs → (utilizadores, chaves), sem consultas extra. */
export function buildTree(data: AdminData): TenantNode[] {
  return data.tenants.map((tenant) => ({
    tenant,
    orgs: data.orgs
      .filter((o) => o.tenantSlug === tenant.slug)
      .map((org) => ({
        org,
        users: data.users.filter((u) => u.sfOrgRef === org.sfOrgRef),
        keys: data.keys.filter((k) => k.org === org.sfOrgRef),
      })),
  }));
}
