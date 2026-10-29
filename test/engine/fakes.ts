import type { AccessChecker } from '../../src/engine/access.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../src/engine/llm.js';
import type { Memory, MemoryStore, RequestMemories } from '../../src/engine/memory.js';
import type { EngineStore, ToolSettings } from '../../src/engine/store.js';
import type { ToolDefaults } from '../../src/engine/tool.js';
import { EngineError } from '../../src/engine/errors.js';

/** Respostas HTTP gravadas para substituir o `fetch` nos testes dos clientes. */
export function fakeFetch(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeAccess(outcome: 'allow' | EngineError = 'allow') {
  const calls: { orgId: string; userId: string }[] = [];
  const access: AccessChecker = {
    check: async (req) => {
      calls.push(req);
      if (outcome !== 'allow') throw outcome;
    },
  };
  return { access, calls };
}

/** A configuração e as memórias que o motor lê, para espalhar nas dependências (`...fakeStore()`). */
export function fakeStore(
  memories: RequestMemories = { org: [], user: [] },
  overrides: Partial<ToolSettings> = {},
) {
  const store: EngineStore = {
    settingsFor: async (_tool: string, defaults: ToolDefaults, defaultModel: string) => ({
      ...defaults,
      model: defaultModel,
      enabled: true,
      systemPrompt: undefined,
      ...overrides,
    }),
  };
  const memoryReader: Pick<MemoryStore, 'forRequest'> = { forRequest: async () => memories };
  return { store, memories: memoryReader };
}

/** Devolve as respostas por ordem; a última repete-se. */
export function fakeLlm(...texts: (string | EngineError)[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider = {
    complete: async (req): Promise<LlmResponse> => {
      requests.push(req);
      const next = texts[Math.min(requests.length - 1, texts.length - 1)];
      if (next instanceof EngineError) throw next;
      return {
        text: next ?? '',
        model: req.model,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      };
    },
  };
  return { llm, requests };
}

/** Um `MemoryStore` em memória, com os filtros por dono, âmbito e ferramenta. */
export function fakeMemoryStore() {
  const rows = new Map<string, Memory>();
  let next = 0;
  const matches = (m: Memory, f: Parameters<MemoryStore['list']>[0]): boolean =>
    (f.orgId === undefined || m.orgId === f.orgId) &&
    (f.userId === undefined || m.userId === f.userId) &&
    (f.scope === undefined || m.scope === f.scope) &&
    (f.tool === undefined || m.tools.length === 0 || m.tools.includes(f.tool));
  const store: MemoryStore = {
    forRequest: async () => ({ org: [], user: [] }),
    list: async (filter) => [...rows.values()].filter((m) => matches(m, filter)),
    count: async (filter) => [...rows.values()].filter((m) => matches(m, filter)).length,
    get: async (id) => rows.get(id),
    create: async ({ owner, source, content, tools }) => {
      next += 1;
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
      const now = new Date();
      rows.set(id, {
        id,
        scope: owner.userId === undefined ? 'org' : 'user',
        source,
        orgId: owner.orgId,
        userId: owner.userId ?? null,
        content,
        tools,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    },
    update: async (id, change) => {
      const m = rows.get(id);
      if (m !== undefined) rows.set(id, { ...m, ...change });
    },
    delete: async (id) => rows.delete(id),
    deleteAllOf: async () => 0,
    summary: async (orgId) => ({ orgId, org: { count: 0, limit: 50 }, users: [] }),
  };
  return { store, rows };
}
