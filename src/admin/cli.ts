import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { AdminError, createOrgMemory, deleteMemoriesOf, deleteMemory } from './commands.js';
import { listMemories } from './queries.js';
import { validateMemoryId } from './validation.js';

const USAGE = `Uso: admin <comando> [opções]

Orgs e utilizadores gerem-se no StepAccess. Aqui só se gerem as memórias da IRIS.

  list-memories     [--org-id <00D…>] [--user-id <005…>]
  add-org-memory    --org-id <00D…> --text "<regra da empresa>" [--tool <código>]…
  delete-memory     --id <uuid>
  delete-memories   --org-id <00D…> [--user-id <005…>]   (quando a org ou o utilizador sai)
  tui               interface interativa
`;

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new AdminError(`Falta --${flag}.`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      'org-id': { type: 'string' },
      'user-id': { type: 'string' },
      text: { type: 'string' },
      tool: { type: 'string', multiple: true },
      id: { type: 'string' },
    },
    strict: true,
  });

  const config = loadConfig();
  if (config.databaseUrl === undefined) throw new ConfigError(['DATABASE_URL: obrigatório']);
  const pool = createPool(config.databaseUrl);

  try {
    switch (command) {
      case 'list-memories': {
        const memories = await listMemories(pool, {
          ...(values['org-id'] !== undefined && { sfOrgRef: values['org-id'] }),
          ...(values['user-id'] !== undefined && { sfUserRef: values['user-id'] }),
        });
        if (memories.length === 0) console.log('Sem memórias.');
        else
          console.table(
            memories.map((m) => ({
              id: m.memoryId,
              ambito: m.scope,
              org: m.sfOrgRef,
              utilizador: m.sfUserRef ?? '',
              ferramentas: m.tools.length === 0 ? 'todas' : m.tools.join(', '),
              origem: m.source,
              texto: m.content,
            })),
          );
        break;
      }
      case 'add-org-memory': {
        const { memoryId } = await createOrgMemory(pool, {
          sfOrgRef: required(values['org-id'], 'org-id'),
          content: required(values.text, 'text'),
          tools: values.tool ?? [],
        });
        console.log(`Memória da org criada (${memoryId}).`);
        break;
      }
      case 'delete-memory': {
        const id = required(values.id, 'id');
        const invalid = validateMemoryId(id);
        if (invalid !== undefined) throw new AdminError(invalid);
        await deleteMemory(pool, { memoryId: id });
        console.log('Memória apagada.');
        break;
      }
      case 'delete-memories': {
        const count = await deleteMemoriesOf(pool, {
          sfOrgRef: required(values['org-id'], 'org-id'),
          ...(values['user-id'] !== undefined && { sfUserRef: values['user-id'] }),
        });
        console.log(`${String(count)} ${count === 1 ? 'memória apagada' : 'memórias apagadas'}.`);
        break;
      }
      case 'tui': {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new AdminError(
            'A interface precisa de um terminal interativo. Com Docker: docker compose run --rm admin tui',
          );
        }
        // Só se carrega aqui: os outros comandos não precisam do Ink nem do React.
        const { runTui } = await import('./tui/run.js');
        const { createAdminApi } = await import('./api.js');
        await runTui(createAdminApi(pool));
        break;
      }
      default:
        throw new AdminError(`Comando desconhecido: ${command}\n\n${USAGE}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof AdminError || err instanceof ConfigError) {
    console.error(err.message);
  } else if (
    err instanceof Error &&
    (err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  ) {
    console.error(`${err.message}\n\n${USAGE}`);
  } else if (err instanceof Error && 'constraint' in err) {
    // Violação de uma restrição da base de dados (formato de id, etc.).
    console.error(`Valor inválido: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
