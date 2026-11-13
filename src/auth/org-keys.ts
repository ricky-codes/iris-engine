import { randomBytes } from 'node:crypto';
import {
  peekKid,
  TOKEN_CLOCK_SKEW_SECONDS,
  verifyOrgToken,
  type OrgSigningKey,
  type TokenCheck,
  type TokenRejection,
} from './org-token.js';

/** Uma chave como a API de administração a mostra: nunca o segredo. */
export interface OrgKeyInfo {
  kid: string;
  orgId: string;
  /** Etiqueta livre ("Produção", "Sandbox UAT"…). */
  label: string | null;
  status: 'active' | 'revoked';
  createdAt: Date;
  createdBy: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  /** Última vez que a IRIS aceitou um token desta chave (com até um minuto de atraso). */
  lastUsedAt: Date | null;
}

/** Onde as chaves vivem. O segredo é guardado cifrado (ver src/adapters/postgres-org-key-store.ts). */
export interface OrgKeyStore {
  /** A chave ativa com este id, ou `undefined` (não existe ou está revogada). */
  findActive(kid: string): Promise<OrgSigningKey | undefined>;
  /** Grava uma chave nova. `undefined` se a org já tem `maxActive` chaves ativas. */
  insert(
    key: OrgSigningKey,
    actor: string,
    maxActive: number,
    label: string | null,
  ): Promise<OrgKeyInfo | undefined>;
  /** Muda a etiqueta. `undefined` se a chave não existe nesta org. */
  setLabel(orgId: string, kid: string, label: string | null): Promise<OrgKeyInfo | undefined>;
  list(orgId: string): Promise<OrgKeyInfo[]>;
  /** Regista que a chave foi usada agora. */
  touch(kid: string): Promise<void>;
  /** `false` se a chave não existe nesta org ou já estava revogada. */
  revoke(orgId: string, kid: string, actor: string): Promise<boolean>;
}

/** Chaves ativas por org: a atual e a próxima, durante uma rotação. */
export const MAX_ACTIVE_KEYS_PER_ORG = 2;
/** Quanto tempo uma chave lida fica em memória. É o atraso máximo de uma revogação noutras instâncias. */
export const KEY_CACHE_MS = 30_000;
/** De quanto em quanto tempo, no máximo, se grava o último uso de uma chave. */
export const LAST_USED_WRITE_MS = 60_000;
/** Um `kid` que não existe fica em memória menos tempo, para uma chave nova aparecer depressa. */
const MISS_CACHE_MS = 5_000;

export class OrgKeyError extends Error {
  constructor(
    public readonly kind: 'limit' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'OrgKeyError';
  }
}

/**
 * As chaves das orgs: verifica tokens (com cache das chaves e proteção contra repetições) e
 * cria, lista e revoga chaves para a API de administração.
 *
 * A cache e os `jti` já vistos são por instância: com várias instâncias, uma revogação demora
 * até `KEY_CACHE_MS` a chegar às outras, e um token repetido noutra instância não é apanhado
 * (vive no máximo 5 minutos).
 */
export class OrgKeys {
  private readonly cache = new Map<string, { key: OrgSigningKey | undefined; until: number }>();
  private readonly seenJti = new Map<string, number>();
  private readonly lastTouch = new Map<string, number>();
  private accepted = 0;
  private readonly rejected = new Map<TokenRejection, number>();
  private lastSweep = 0;

  constructor(
    private readonly store: OrgKeyStore,
    private readonly nowMs: () => number = () => Date.now(),
    /** Falhas ao gravar o último uso: não afetam o pedido, só se registam. */
    private readonly onTouchError: (err: unknown) => void = () => undefined,
  ) {}

  /** Verifica um token. Nunca lança por causa do token; só se a base de dados falhar. */
  async verify(token: string): Promise<TokenCheck> {
    const kid = peekKid(token);
    const key = kid === undefined ? undefined : await this.key(kid);
    const now = this.nowMs();
    this.sweep(now);
    const check = verifyOrgToken(token, key, Math.floor(now / 1000), (orgId, jti, exp) => {
      const id = `${orgId}:${jti}`;
      if (this.seenJti.has(id)) return true;
      this.seenJti.set(id, (exp + TOKEN_CLOCK_SKEW_SECONDS) * 1000);
      return false;
    });
    if (check.ok) {
      this.accepted++;
      this.touch(check.kid, now);
    } else {
      this.rejected.set(check.reason, (this.rejected.get(check.reason) ?? 0) + 1);
    }
    return check;
  }

  /** Grava o último uso em segundo plano, no máximo uma vez por minuto por chave. */
  private touch(kid: string, now: number): void {
    const last = this.lastTouch.get(kid);
    if (last !== undefined && now - last < LAST_USED_WRITE_MS) return;
    this.lastTouch.set(kid, now);
    this.store.touch(kid).catch(this.onTouchError);
  }

  /** Tokens aceites e recusados (por razão) nesta instância, desde o arranque. Só contagens. */
  stats(): { accepted: number; rejected: number; rejectedByReason: Record<string, number> } {
    const rejectedByReason = Object.fromEntries(
      [...this.rejected].sort(([a], [b]) => a.localeCompare(b)),
    );
    const rejected = [...this.rejected.values()].reduce((a, b) => a + b, 0);
    return { accepted: this.accepted, rejected, rejectedByReason };
  }

  /** Cria uma chave. O segredo só existe aqui: devolve-se uma vez e guarda-se cifrado. */
  async create(
    orgId: string,
    actor: string,
    label: string | null = null,
  ): Promise<OrgKeyInfo & { secret: string }> {
    const key: OrgSigningKey = {
      kid: `k_${randomBytes(8).toString('hex')}`,
      orgId,
      secret: randomBytes(32).toString('base64url'),
    };
    const info = await this.store.insert(key, actor, MAX_ACTIVE_KEYS_PER_ORG, label);
    if (info === undefined) {
      throw new OrgKeyError(
        'limit',
        `A org já tem ${MAX_ACTIVE_KEYS_PER_ORG} chaves ativas: revogue uma antes de criar outra.`,
      );
    }
    this.cache.delete(key.kid);
    return { ...info, secret: key.secret };
  }

  list(orgId: string): Promise<OrgKeyInfo[]> {
    return this.store.list(orgId);
  }

  async relabel(orgId: string, kid: string, label: string | null): Promise<OrgKeyInfo> {
    const info = await this.store.setLabel(orgId, kid, label);
    if (info === undefined) throw new OrgKeyError('not_found', 'Chave não encontrada.');
    return info;
  }

  async revoke(orgId: string, kid: string, actor: string): Promise<void> {
    const done = await this.store.revoke(orgId, kid, actor);
    // Nesta instância, a revogação vale já.
    this.cache.delete(kid);
    if (!done) throw new OrgKeyError('not_found', 'Chave não encontrada ou já revogada.');
  }

  private async key(kid: string): Promise<OrgSigningKey | undefined> {
    const now = this.nowMs();
    const hit = this.cache.get(kid);
    if (hit !== undefined && hit.until > now) return hit.key;
    const key = await this.store.findActive(kid);
    this.cache.set(kid, { key, until: now + (key === undefined ? MISS_CACHE_MS : KEY_CACHE_MS) });
    return key;
  }

  /** Esquece os `jti` expirados e as entradas velhas da cache, no máximo uma vez por minuto. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, until] of this.seenJti) if (until <= now) this.seenJti.delete(id);
    for (const [kid, entry] of this.cache) if (entry.until <= now) this.cache.delete(kid);
    for (const [kid, at] of this.lastTouch)
      if (now - at >= LAST_USED_WRITE_MS) this.lastTouch.delete(kid);
  }
}
