import { describe, expect, it } from 'vitest';
import type { KeySummary } from '../../src/admin/commands.js';
import {
  buildTree,
  type AdminData,
  type OrgRow,
  type TenantRow,
  type UserRow,
} from '../../src/admin/queries.js';
import { relationLines } from '../../src/admin/tui/relations.js';

const D = new Date('2026-10-08T12:00:00Z');
const tenant = (slug: string, isActive = true): TenantRow => ({
  tenantId: `t-${slug}`,
  slug,
  name: slug.toUpperCase(),
  isActive,
  retentionDays: 30,
  orgCount: 0,
  createdAt: D,
});
const org = (ref: string, tenantSlug: string, isSandbox = false, isActive = true): OrgRow => ({
  sfOrgId: `o-${ref}`,
  sfOrgRef: ref,
  tenantSlug,
  instanceUrl: 'https://x.my.salesforce.com',
  isSandbox,
  isActive,
  userCount: 0,
  createdAt: D,
});
const user = (ref: string, sfOrgRef: string, tenantSlug: string): UserRow => ({
  orgUserId: `u-${ref}`,
  sfUserRef: ref,
  sfOrgRef,
  tenantSlug,
  firstSeenAt: D,
  requestCount: 2,
  memoryCount: 0,
});
const key = (
  keyPrefix: string,
  orgRef: string,
  tenantSlug: string,
  status: KeySummary['status'],
): KeySummary => ({
  tenant: tenantSlug,
  org: orgRef,
  isSandbox: false,
  keyPrefix,
  status,
  createdAt: D,
  expiresAt: null,
});

const data: AdminData = {
  tenants: [tenant('a'), tenant('b', false)],
  orgs: [
    org('00DAAAAAAAAAAAAAAA', 'a', true),
    org('00DBBBBBBBBBBBBBBB', 'a'),
    org('00DCCCCCCCCCCCCCCC', 'b'),
  ],
  users: [
    user('005AAAAAAAAAAAAAAA', '00DAAAAAAAAAAAAAAA', 'a'),
    user('005BBBBBBBBBBBBBBB', '00DAAAAAAAAAAAAAAA', 'a'),
  ],
  keys: [
    key('11111111', '00DAAAAAAAAAAAAAAA', 'a', 'ativa'),
    key('22222222', '00DAAAAAAAAAAAAAAA', 'a', 'revogada'),
  ],
};

describe('árvore de relações', () => {
  it('liga clientes, orgs, utilizadores e chaves', () => {
    const tree = buildTree(data);
    expect(tree.map((t) => t.tenant.slug)).toEqual(['a', 'b']);
    expect(tree[0]?.orgs.map((o) => o.org.sfOrgRef)).toEqual([
      '00DAAAAAAAAAAAAAAA',
      '00DBBBBBBBBBBBBBBB',
    ]);
    expect(tree[0]?.orgs[0]?.users).toHaveLength(2);
    expect(tree[0]?.orgs[0]?.keys.map((k) => k.keyPrefix)).toEqual(['11111111', '22222222']);
    expect(tree[0]?.orgs[1]?.users).toHaveLength(0);
    expect(tree[1]?.orgs).toHaveLength(1);
  });

  it('uma árvore vazia não gera linhas', () => {
    expect(relationLines(buildTree({ tenants: [], orgs: [], users: [], keys: [] }))).toEqual([]);
  });

  it('gera uma linha por elemento, com a indentação e o estado certos', () => {
    const text = relationLines(buildTree(data)).map((l) => l.text);
    expect(text[0]).toBe('▾ a  A');
    expect(text).toContain('  ▾ org 00DAAAAAAAAAAAAAAA  sandbox');
    expect(text).toContain('  ▾ org 00DBBBBBBBBBBBBBBB  produção');
    expect(text).toContain('      2 utilizadores');
    expect(text).toContain('      0 utilizadores');
    expect(text.some((t) => t.includes('005AAAAAAAAAAAAAAA') && t.includes('2 pedidos'))).toBe(
      true,
    );
    expect(text.some((t) => t.includes('11111111') && t.includes('ativa'))).toBe(true);
    expect(text.some((t) => t.includes('22222222') && t.includes('revogada'))).toBe(true);
    expect(text.some((t) => t.startsWith('▾ b') && t.includes('(desativado)'))).toBe(true);
  });

  it('cores: chave ativa a verde, revogada a vermelho, cliente desativado a vermelho', () => {
    const lines = relationLines(buildTree(data));
    expect(lines.find((l) => l.text.includes('11111111'))?.color).toBe('green');
    expect(lines.find((l) => l.text.includes('22222222'))?.color).toBe('red');
    expect(lines.find((l) => l.text.startsWith('▾ b'))?.color).toBe('red');
  });

  it('corta a lista de utilizadores de uma org muito grande', () => {
    const many: AdminData = {
      tenants: [tenant('a')],
      orgs: [org('00DAAAAAAAAAAAAAAA', 'a')],
      users: Array.from({ length: 60 }, (_, i) =>
        user(`005${String(i).padStart(15, '0')}`, '00DAAAAAAAAAAAAAAA', 'a'),
      ),
      keys: [],
    };
    const text = relationLines(buildTree(many)).map((l) => l.text);
    expect(text).toContain('      60 utilizadores');
    expect(text.filter((t) => t.includes('desde')).length).toBe(25);
    expect(text).toContain('        … e mais 35');
  });
});
