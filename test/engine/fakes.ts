import type { AccessChecker } from '../../src/engine/access.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../src/engine/llm.js';
import type { EngineStore, RequestMemories, ToolSettings } from '../../src/engine/store.js';
import type { ToolDefaults } from '../../src/engine/tool.js';
import { AppError } from '../../src/http/errors.js';

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

export function fakeAccess(outcome: 'allow' | AppError = 'allow') {
  const calls: { orgId: string; userId: string }[] = [];
  const access: AccessChecker = {
    check: async (req) => {
      calls.push(req);
      if (outcome !== 'allow') throw outcome;
    },
  };
  return { access, calls };
}

export function fakeStore(
  memories: RequestMemories = { org: [], user: [] },
  overrides: Partial<ToolSettings> = {},
) {
  const store: EngineStore = {
    memoriesFor: async () => memories,
    settingsFor: async (_tool: string, defaults: ToolDefaults, defaultModel: string) => ({
      ...defaults,
      model: defaultModel,
      enabled: true,
      systemPrompt: undefined,
      ...overrides,
    }),
  };
  return store;
}

/** Devolve as respostas por ordem; a última repete-se. */
export function fakeLlm(...texts: (string | AppError)[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider = {
    complete: async (req): Promise<LlmResponse> => {
      requests.push(req);
      const next = texts[Math.min(requests.length - 1, texts.length - 1)];
      if (next instanceof AppError) throw next;
      return { text: next ?? '', model: req.model, inputTokens: 10, outputTokens: 5 };
    },
  };
  return { llm, requests };
}
