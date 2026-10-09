import type { Pool } from 'pg';
import {
  createApiKey,
  createOrg,
  createOrgUser,
  createTenant,
  deleteOrgUser,
  listKeys,
  previewUserDeletion,
  revokeApiKey,
  setOrgActive,
  setTenantActive,
  type CreatedKey,
  type UserDeletionPreview,
} from './commands.js';
import { listOrgs, listTenants, listUsers, type AdminData } from './queries.js';

/**
 * O que a interface de terminal pode fazer. É uma interface para a UI não depender da
 * base de dados: os testes usam uma versão em memória.
 */
export interface AdminApi {
  load(): Promise<AdminData>;
  createTenant(input: { slug: string; name: string; retentionDays?: number }): Promise<void>;
  createOrg(input: {
    tenantSlug: string;
    sfOrgRef: string;
    instanceUrl: string;
    isSandbox: boolean;
  }): Promise<void>;
  createOrgUser(input: { sfOrgRef: string; sfUserRef: string }): Promise<void>;
  createApiKey(input: { sfOrgRef: string; expiresInDays?: number }): Promise<CreatedKey>;
  revokeApiKey(keyPrefix: string): Promise<void>;
  setTenantActive(slug: string, isActive: boolean): Promise<void>;
  setOrgActive(sfOrgRef: string, isActive: boolean): Promise<void>;
  previewUserDeletion(orgUserId: string): Promise<UserDeletionPreview>;
  deleteOrgUser(orgUserId: string): Promise<void>;
}

export function createAdminApi(pool: Pool): AdminApi {
  return {
    load: async () => {
      const [tenants, orgs, users, keys] = await Promise.all([
        listTenants(pool),
        listOrgs(pool),
        listUsers(pool),
        listKeys(pool),
      ]);
      return { tenants, orgs, users, keys };
    },
    createTenant: async (input) => {
      await createTenant(pool, input);
    },
    createOrg: async (input) => {
      await createOrg(pool, input);
    },
    createOrgUser: async (input) => {
      await createOrgUser(pool, input);
    },
    createApiKey: (input) => createApiKey(pool, input),
    revokeApiKey: async (keyPrefix) => {
      const done = await revokeApiKey(pool, { keyPrefix });
      if (!done) throw new Error('A chave não existe ou já estava revogada.');
    },
    setTenantActive: (slug, isActive) => setTenantActive(pool, { slug, isActive }),
    setOrgActive: (sfOrgRef, isActive) => setOrgActive(pool, { sfOrgRef, isActive }),
    previewUserDeletion: (orgUserId) => previewUserDeletion(pool, { orgUserId }),
    deleteOrgUser: (orgUserId) => deleteOrgUser(pool, { orgUserId }),
  };
}
