import type { TenantNode } from '../queries.js';
import { fmtDate, plural } from './format.js';

export interface RelationLine {
  text: string;
  color?: string;
  bold?: boolean;
}

const MAX_USERS_PER_ORG = 25;

/** Transforma a árvore cliente → org → (utilizadores, chaves) em linhas de texto para mostrar. */
export function relationLines(tree: TenantNode[]): RelationLine[] {
  if (tree.length === 0) return [];
  const lines: RelationLine[] = [];

  for (const { tenant, orgs } of tree) {
    lines.push({
      text: `▾ ${tenant.slug}  ${tenant.name}  ${tenant.isActive ? '' : '(desativado)'}`.trimEnd(),
      color: tenant.isActive ? 'cyan' : 'red',
      bold: true,
    });
    if (orgs.length === 0) lines.push({ text: '    sem orgs', color: 'gray' });

    for (const { org, users, keys } of orgs) {
      const kind = org.isSandbox ? 'sandbox' : 'produção';
      lines.push({
        text: `  ▾ org ${org.sfOrgRef}  ${kind}${org.isActive ? '' : '  (desativada)'}`,
        color: org.isActive ? 'white' : 'red',
        bold: true,
      });

      lines.push({
        text: `      ${plural(users.length, 'utilizador', 'utilizadores')}`,
        color: 'gray',
      });
      for (const user of users.slice(0, MAX_USERS_PER_ORG)) {
        lines.push({
          text: `        ${user.sfUserRef}  desde ${fmtDate(user.firstSeenAt)}  ${plural(user.requestCount, 'pedido', 'pedidos')}  ${plural(user.memoryCount, 'memória', 'memórias')}`,
        });
      }
      if (users.length > MAX_USERS_PER_ORG) {
        lines.push({
          text: `        … e mais ${String(users.length - MAX_USERS_PER_ORG)}`,
          color: 'gray',
        });
      }

      lines.push({ text: `      ${plural(keys.length, 'chave', 'chaves')}`, color: 'gray' });
      for (const key of keys) {
        const color =
          key.status === 'ativa' ? 'green' : key.status === 'revogada' ? 'red' : 'yellow';
        lines.push({
          text: `        ${key.keyPrefix}  ${key.status}  criada ${fmtDate(key.createdAt)}  expira ${fmtDate(key.expiresAt)}`,
          color,
        });
      }
    }
    lines.push({ text: '' });
  }
  return lines;
}
