/**
 * O motor sem o servidor HTTP: o mínimo para correr uma ferramenta e gerir memórias a
 * partir de outro programa (um script, uma fila, outro serviço).
 *
 *   DATABASE_URL=postgres://… OPENROUTER_API_KEY=… npx tsx examples/engine-only.ts
 *
 * Usa a mesma base de dados do servidor (depois de `npm run migrate`): as memórias que
 * guarda aqui ficam lá e sobrevivem a reinícios. O acesso fica aberto (sem StepAccess),
 * como com ACCESS_MODE=open.
 */
import pg from 'pg';
import { OpenAccessChecker } from '../src/adapters/open-access.js';
import { OpenRouterProvider } from '../src/adapters/openrouter.js';
import { PgMemoryStore } from '../src/adapters/postgres-memory-store.js';
import { PgEngineStore, syncToolCatalog } from '../src/adapters/postgres-store.js';
import { createEngine } from '../src/engine/engine.js';
import { EngineError } from '../src/engine/errors.js';
import type { ToolDefinition } from '../src/engine/tool.js';
import { diagnosticTool } from '../src/tools/diagnostic.js';

// Exemplo: só aqui se lê o ambiente.
// eslint-disable-next-line no-restricted-properties
const { DATABASE_URL, OPENROUTER_API_KEY } = process.env;
if (DATABASE_URL === undefined || OPENROUTER_API_KEY === undefined) {
  console.error('Defina DATABASE_URL e OPENROUTER_API_KEY.');
  process.exit(1);
}

const ORG = '00D000000000000AAA';
const USER = '005000000000000AAA';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const tools = [diagnosticTool as unknown as ToolDefinition];
await syncToolCatalog(
  pool,
  tools.map((t) => t.name),
);

const engine = createEngine({
  settings: { defaultModel: 'google/gemini-2.5-flash' },
  tools,
  access: new OpenAccessChecker(),
  store: new PgEngineStore(pool),
  memories: new PgMemoryStore(pool),
  llm: new OpenRouterProvider({
    apiKey: OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
  }),
  onEvent: (e) => {
    console.log('evento:', e.type, e.tool, `${String(e.durationMs)} ms`);
  },
});

try {
  // Guarda uma memória do utilizador (fica na base de dados).
  const memory = await engine.memories.remember({
    owner: { orgId: ORG, userId: USER },
    source: 'user',
    content: 'Responde sempre em maiúsculas.',
  });
  console.log('memória guardada:', memory.id);

  // Corre a ferramenta: a memória entra no prompt.
  const { result, meta } = await engine.run('diagnostic', {
    orgId: ORG,
    userId: USER,
    input: { message: 'Olá! Está tudo a funcionar?' },
  });
  console.log('resultado:', result, '· custo (USD):', meta.costUsd);

  // Vê e apaga.
  const { items } = await engine.memories.list({ orgId: ORG, userId: USER });
  console.log('memórias do utilizador:', items.length);
  await engine.memories.forget(memory.id, { orgId: ORG, userId: USER });
} catch (err) {
  if (err instanceof EngineError) console.error(`${err.code}: ${err.message}`, err.details);
  else throw err;
} finally {
  await pool.end();
}
