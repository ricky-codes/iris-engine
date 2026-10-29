import { EngineError } from './errors.js';

/**
 * Limites das memórias. A base de dados aplica os mesmos valores (migração 0009):
 * aqui servem para recusar antes de a base de dados o fazer.
 */
export const MAX_MEMORY_CHARS = 500;
export const MAX_ORG_MEMORIES = 50;
export const MAX_USER_MEMORIES = 20;

/** `org`: regra da empresa, para todos os utilizadores · `user`: preferência de um utilizador. */
export type MemoryScope = 'org' | 'user';
/** Quem a criou: o próprio utilizador ou um administrador. */
export type MemorySource = 'user' | 'admin';

export interface Memory {
  id: string;
  scope: MemoryScope;
  source: MemorySource;
  orgId: string;
  /** Só nas memórias de utilizador. */
  userId: string | null;
  content: string;
  /** Códigos das ferramentas a que se aplica. Vazio: todas. */
  tools: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** As memórias que entram no prompt de um pedido. */
export interface RequestMemories {
  /** Regras da empresa. Prevalecem sobre as do utilizador. */
  org: string[];
  /** Preferências do próprio utilizador. */
  user: string[];
}

export interface MemoryFilter {
  orgId?: string;
  userId?: string;
  scope?: MemoryScope;
  /** Só memórias que valem para esta ferramenta (incluindo as que valem para todas). */
  tool?: string;
  /** Procura no texto (sem distinguir maiúsculas). */
  search?: string;
}

export interface MemorySummary {
  orgId: string;
  org: { count: number; limit: number };
  users: { userId: string; count: number; limit: number }[];
}

/** O dono de uma memória: a org, ou um utilizador dentro da org. */
export interface MemoryOwner {
  orgId: string;
  userId?: string;
}

/**
 * Onde as memórias vivem. Só guarda e lê: as regras estão em `Memories`.
 * Lança `EngineError` `memory_limit_reached` quando o dono já está no limite e
 * `invalid_request` quando uma ferramenta não existe.
 */
export interface MemoryStore {
  forRequest(request: { orgId: string; userId: string; tool: string }): Promise<RequestMemories>;
  list(filter: MemoryFilter, page: { limit?: number; offset?: number }): Promise<Memory[]>;
  count(filter: MemoryFilter): Promise<number>;
  get(id: string): Promise<Memory | undefined>;
  create(input: {
    owner: MemoryOwner;
    source: MemorySource;
    content: string;
    tools: string[];
  }): Promise<string>;
  update(id: string, change: { content?: string; tools?: string[] }): Promise<void>;
  /** `false` se a memória não existia. */
  delete(id: string): Promise<boolean>;
  /** Apaga as do utilizador, ou as da org e de todos os seus utilizadores. Devolve quantas. */
  deleteAllOf(owner: MemoryOwner): Promise<number>;
  summary(orgId: string): Promise<MemorySummary>;
}

const notFound = (): EngineError => new EngineError('not_found', 'A memória já não existe.');

function cleanContent(content: string): string {
  const text = content.trim();
  if (text === '') throw new EngineError('invalid_request', 'O texto não pode estar vazio.');
  if (text.length > MAX_MEMORY_CHARS) {
    throw new EngineError(
      'invalid_request',
      `No máximo ${String(MAX_MEMORY_CHARS)} caracteres (tem ${String(text.length)}).`,
    );
  }
  return text;
}

const ownedBy = (m: Memory, owner: MemoryOwner): boolean =>
  m.orgId === owner.orgId && m.userId === (owner.userId ?? null);

/**
 * As memórias de orgs e utilizadores: guardar, ver, alterar, apagar e juntar ao prompt.
 * Nada aqui é automático: cada memória é criada ou apagada por um pedido explícito.
 */
export class Memories {
  constructor(private readonly store: MemoryStore) {}

  /** As memórias que valem para um pedido a uma ferramenta. */
  forRequest(request: { orgId: string; userId: string; tool: string }): Promise<RequestMemories> {
    return this.store.forRequest(request);
  }

  /** Memórias da org primeiro, depois por utilizador; dentro de cada dono, as mais recentes primeiro. */
  async list(
    filter: MemoryFilter = {},
    page: { limit?: number; offset?: number } = {},
  ): Promise<{ items: Memory[]; total: number }> {
    const [items, total] = await Promise.all([
      this.store.list(filter, page),
      this.store.count(filter),
    ]);
    return { items, total };
  }

  /** Quantas memórias cumprem o filtro. */
  count(filter: MemoryFilter = {}): Promise<number> {
    return this.store.count(filter);
  }

  /** Uma memória pelo id, ou `undefined` se não existir. */
  get(id: string): Promise<Memory | undefined> {
    return this.store.get(id);
  }

  private async mustGet(id: string): Promise<Memory> {
    const m = await this.store.get(id);
    if (m === undefined) throw notFound();
    return m;
  }

  /**
   * Guarda uma memória. Com `userId` é do utilizador; sem ele é da org e vale para
   * todos os utilizadores dela. Sem ferramentas, vale para todas.
   */
  async remember(input: {
    owner: MemoryOwner;
    source: MemorySource;
    content: string;
    tools?: string[];
  }): Promise<Memory> {
    const id = await this.store.create({
      owner: input.owner,
      source: input.source,
      content: cleanContent(input.content),
      tools: [...new Set(input.tools ?? [])],
    });
    return this.mustGet(id);
  }

  /**
   * Altera o texto e/ou as ferramentas de uma memória da org. As memórias de utilizador
   * pertencem ao utilizador: só ele as cria, e os outros só as podem apagar.
   */
  async update(id: string, change: { content?: string; tools?: string[] }): Promise<Memory> {
    const m = await this.mustGet(id);
    if (m.scope !== 'org') {
      throw new EngineError(
        'forbidden',
        'As memórias de utilizador só podem ser apagadas, não alteradas.',
      );
    }
    await this.store.update(id, {
      ...(change.content !== undefined && { content: cleanContent(change.content) }),
      ...(change.tools !== undefined && { tools: [...new Set(change.tools)] }),
    });
    return this.mustGet(id);
  }

  /**
   * Apaga uma memória. Com `owner`, só a apaga se for desse dono (um utilizador não
   * apaga as de outro nem as da org); a de outro dono conta como inexistente.
   */
  async forget(id: string, owner?: MemoryOwner): Promise<void> {
    if (owner !== undefined) {
      const m = await this.store.get(id);
      if (m === undefined || !ownedBy(m, owner)) throw notFound();
    }
    if (!(await this.store.delete(id))) throw notFound();
  }

  /** Apaga as memórias de quem sai: de um utilizador, ou da org e de todos os seus utilizadores. */
  forgetAllOf(owner: MemoryOwner): Promise<number> {
    return this.store.deleteAllOf(owner);
  }

  /** Quantas memórias tem uma org e cada utilizador dela, face aos limites. */
  summary(orgId: string): Promise<MemorySummary> {
    return this.store.summary(orgId);
  }
}
