import type { Pool } from 'pg';
import { createOrgMemory, deleteMemory } from './commands.js';
import { listMemories, listTools, type AdminData } from './queries.js';

/**
 * O que a interface de terminal pode fazer. É uma interface para a UI não depender da
 * base de dados: os testes usam uma versão em memória.
 */
export interface AdminApi {
  load(): Promise<AdminData>;
  createOrgMemory(input: { sfOrgRef: string; content: string; tools: string[] }): Promise<void>;
  deleteMemory(memoryId: string): Promise<void>;
}

export function createAdminApi(pool: Pool): AdminApi {
  return {
    load: async () => {
      const [memories, tools] = await Promise.all([listMemories(pool), listTools(pool)]);
      return { memories, tools };
    },
    createOrgMemory: async (input) => {
      await createOrgMemory(pool, input);
    },
    deleteMemory: (memoryId) => deleteMemory(pool, { memoryId }),
  };
}
