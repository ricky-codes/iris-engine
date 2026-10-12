import type { AdminApi } from '../../src/admin/api.js';
import { AdminError } from '../../src/admin/commands.js';
import type { AdminData, MemoryRow } from '../../src/admin/queries.js';

const D = new Date('2026-10-08T12:00:00Z');

export const orgMemory = (
  id: string,
  sfOrgRef: string,
  content: string,
  o: Partial<MemoryRow> = {},
): MemoryRow => ({
  memoryId: id,
  scope: 'org',
  source: 'admin',
  sfOrgRef,
  sfUserRef: null,
  content,
  tools: [],
  createdAt: D,
  updatedAt: D,
  ...o,
});

export const userMemory = (
  id: string,
  sfOrgRef: string,
  sfUserRef: string,
  content: string,
  o: Partial<MemoryRow> = {},
): MemoryRow => ({
  memoryId: id,
  scope: 'user',
  source: 'user',
  sfOrgRef,
  sfUserRef,
  content,
  tools: [],
  createdAt: D,
  updatedAt: D,
  ...o,
});

/** Uma API de administração em memória, que regista o que lhe pedem. */
export function createFakeApi(seed: Partial<AdminData> = {}) {
  // Cópia profunda: cada teste parte dos mesmos dados sem os alterar para os outros.
  const state: AdminData = structuredClone({
    memories: [],
    tools: [{ code: 'reply' }, { code: 'sentiment' }, { code: 'tipification' }],
    ...seed,
  });
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
    createOrgMemory: async (input) => {
      calls.push(`createOrgMemory ${JSON.stringify(input)}`);
      maybeFail();
      state.memories.push(
        orgMemory(`m-${String(state.memories.length + 1)}`, input.sfOrgRef, input.content, {
          tools: input.tools,
        }),
      );
    },
    deleteMemory: async (id) => {
      calls.push(`deleteMemory ${id}`);
      maybeFail();
      state.memories = state.memories.filter((m) => m.memoryId !== id);
    },
  };

  return { api, state, calls, control };
}
