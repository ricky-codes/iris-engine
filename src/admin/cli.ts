import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import {
  AdminError,
  createApiKey,
  createOrg,
  createTenant,
  listKeys,
  revokeApiKey,
} from './commands.js';

const USAGE = `Uso: admin <comando> [opções]

  create-tenant --slug <slug> --name <nome> [--retention-days <n>]
  create-org    --tenant <slug> --org-id <00D…> --instance-url <https://…> [--sandbox]
  create-key    --org-id <00D…> [--expires-in-days <n>]
  revoke-key    --prefix <8 hexadecimais>
  list-keys
  tui           interface interativa (clientes, orgs, utilizadores, chaves)
`;

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new AdminError(`Falta --${flag}.`);
  return value;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new AdminError(`--${flag} deve ser um inteiro positivo.`);
  return n;
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
      slug: { type: 'string' },
      name: { type: 'string' },
      'retention-days': { type: 'string' },
      tenant: { type: 'string' },
      'org-id': { type: 'string' },
      'instance-url': { type: 'string' },
      sandbox: { type: 'boolean', default: false },
      'expires-in-days': { type: 'string' },
      prefix: { type: 'string' },
    },
    strict: true,
  });

  const config = loadConfig();
  if (config.databaseUrl === undefined) throw new ConfigError(['DATABASE_URL: obrigatório']);
  const pool = createPool(config.databaseUrl);

  try {
    switch (command) {
      case 'create-tenant': {
        const retentionDays = positiveInt(values['retention-days'], 'retention-days');
        await createTenant(pool, {
          slug: required(values.slug, 'slug'),
          name: required(values.name, 'name'),
          ...(retentionDays !== undefined && { retentionDays }),
        });
        console.log(`Cliente "${values.slug}" criado.`);
        break;
      }
      case 'create-org': {
        await createOrg(pool, {
          tenantSlug: required(values.tenant, 'tenant'),
          sfOrgRef: required(values['org-id'], 'org-id'),
          instanceUrl: required(values['instance-url'], 'instance-url'),
          isSandbox: values.sandbox,
        });
        console.log(`Org ${values['org-id']} registada.`);
        break;
      }
      case 'create-key': {
        const expiresInDays = positiveInt(values['expires-in-days'], 'expires-in-days');
        const created = await createApiKey(pool, {
          sfOrgRef: required(values['org-id'], 'org-id'),
          ...(expiresInDays !== undefined && { expiresInDays }),
        });
        console.log(`Chave criada (prefixo ${created.keyPrefix}).`);
        console.log(
          created.expiresAt === null
            ? 'Não expira.'
            : `Expira em ${created.expiresAt.toISOString()}.`,
        );
        console.log('\nGuarde-a agora. Não volta a ser mostrada.\n');
        console.log(`  ${created.key}\n`);
        console.log('No Salesforce, envie-a no cabeçalho:  Authorization: Bearer <chave>');
        break;
      }
      case 'revoke-key': {
        const prefix = required(values.prefix, 'prefix');
        const done = await revokeApiKey(pool, { keyPrefix: prefix });
        console.log(
          done
            ? `Chave ${prefix} revogada.`
            : `Nada a fazer: a chave ${prefix} não existe ou já estava revogada.`,
        );
        break;
      }
      case 'list-keys': {
        const keys = await listKeys(pool);
        if (keys.length === 0) console.log('Sem chaves.');
        else
          console.table(
            keys.map((k) => ({
              ...k,
              createdAt: k.createdAt.toISOString(),
              expiresAt: k.expiresAt?.toISOString() ?? '',
            })),
          );
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
    // Violação de uma restrição da base de dados (formato de id, URL, etc.).
    console.error(`Valor inválido: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
