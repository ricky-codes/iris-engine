import type { AdminApi } from '../../src/admin/api.js';
import { AdminError, type CreatedKey, type KeySummary } from '../../src/admin/commands.js';
import type { AdminData, OrgRow, TenantRow, UserRow } from '../../src/admin/queries.js';

const D = new Date('2026-10-08T12:00:00Z');

export const tenantRow = (slug: string, o: Partial<TenantRow> = {}): TenantRow => ({
  tenantId: `tenant-${slug}`,
  slug,
  name: `Cliente ${slug}`,
  isActive: true,
  retentionDays: 30,
  orgCount: 0,
  createdAt: D,
  ...o,
});

export const orgRow = (ref: string, tenantSlug: string, o: Partial<OrgRow> = {}): OrgRow => ({
  sfOrgId: `org-${ref}`,
  sfOrgRef: ref,
  tenantSlug,
  instanceUrl: `https://${ref.toLowerCase()}.my.salesforce.com`,
  isSandbox: false,
  isActive: true,
  userCount: 0,
  createdAt: D,
  ...o,
});

export const userRow = (
  ref: string,
  sfOrgRef: string,
  tenantSlug: string,
  o: Partial<UserRow> = {},
): UserRow => ({
  orgUserId: `user-${ref}`,
  sfUserRef: ref,
  sfOrgRef,
  tenantSlug,
  firstSeenAt: D,
  requestCount: 0,
  memoryCount: 0,
  ...o,
});

export const keyRow = (
  keyPrefix: string,
  org: string,
  tenant: string,
  status: KeySummary['status'] = 'ativa',
): KeySummary => ({
  tenant,
  org,
  isSandbox: false,
  keyPrefix,
  status,
  createdAt: D,
  expiresAt: null,
});

export const FAKE_KEY = `iris_deadbeef_${'A'.repeat(43)}`;

/** Uma API de administração em memória, que regista o que lhe pedem. */
export function createFakeApi(seed: Partial<AdminData> = {}) {
  // Copia profunda: cada teste parte dos mesmos dados sem os alterar para os outros.
  const state: AdminData = structuredClone({ tenants: [], orgs: [], users: [], keys: [], ...seed });
  const calls: string[] = [];
  const control: { failNext: string | undefined } = { failNext: undefined };

  const maybeFail = (): void => {
    if (control.failNext !== undefined) {
      const message = control.failNext;
      control.failNext = undefined;
      throw new AdminError(message);
    }
  };

  const api: AdminApi = {
    load: async () => structuredClone(state),
    createTenant: async (input) => {
      calls.push(`createTenant ${JSON.stringify(input)}`);
      maybeFail();
      state.tenants.push(
        tenantRow(input.slug, { name: input.name, retentionDays: input.retentionDays ?? 30 }),
      );
    },
    createOrg: async (input) => {
      calls.push(`createOrg ${JSON.stringify(input)}`);
      maybeFail();
      state.orgs.push(
        orgRow(input.sfOrgRef, input.tenantSlug, {
          isSandbox: input.isSandbox,
          instanceUrl: input.instanceUrl,
        }),
      );
    },
    createOrgUser: async (input) => {
      calls.push(`createOrgUser ${JSON.stringify(input)}`);
      maybeFail();
      const org = state.orgs.find((o) => o.sfOrgRef === input.sfOrgRef);
      state.users.push(userRow(input.sfUserRef, input.sfOrgRef, org?.tenantSlug ?? '?'));
    },
    createApiKey: async (input): Promise<CreatedKey> => {
      calls.push(`createApiKey ${JSON.stringify(input)}`);
      maybeFail();
      const org = state.orgs.find((o) => o.sfOrgRef === input.sfOrgRef);
      state.keys.push(keyRow('deadbeef', input.sfOrgRef, org?.tenantSlug ?? '?'));
      return { key: FAKE_KEY, keyPrefix: 'deadbeef', expiresAt: null };
    },
    revokeApiKey: async (prefix) => {
      calls.push(`revokeApiKey ${prefix}`);
      maybeFail();
      const key = state.keys.find((k) => k.keyPrefix === prefix);
      if (key) key.status = 'revogada';
    },
    setTenantActive: async (slug, isActive) => {
      calls.push(`setTenantActive ${slug} ${String(isActive)}`);
      maybeFail();
      const t = state.tenants.find((x) => x.slug === slug);
      if (t) t.isActive = isActive;
    },
    setOrgActive: async (ref, isActive) => {
      calls.push(`setOrgActive ${ref} ${String(isActive)}`);
      maybeFail();
      const o = state.orgs.find((x) => x.sfOrgRef === ref);
      if (o) o.isActive = isActive;
    },
    previewUserDeletion: async (id) => {
      const u = state.users.find((x) => x.orgUserId === id);
      return { requests: u?.requestCount ?? 0, memories: u?.memoryCount ?? 0 };
    },
    deleteOrgUser: async (id) => {
      calls.push(`deleteOrgUser ${id}`);
      maybeFail();
      state.users = state.users.filter((u) => u.orgUserId !== id);
    },
  };

  return { api, state, calls, control };
}
