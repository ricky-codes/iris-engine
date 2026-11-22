import type { Pool } from 'pg';

/**
 * A base de dados descrita a si própria, para a consola: as tabelas que existem de facto (lidas
 * do catálogo do Postgres), quantas linhas têm, as colunas, as ligações entre elas e as migrações
 * aplicadas. Nunca devolve o conteúdo das linhas.
 */

/** O grupo de cada tabela na consola, pela ordem em que aparecem. */
export const TABLE_GROUPS = [
  'tools',
  'prompts',
  'memories',
  'settings',
  'orgKeys',
  'catalogs',
  'system',
] as const;
export type TableGroup = (typeof TABLE_GROUPS)[number];

export interface TableNote {
  group: TableGroup;
  /** Para que serve, numa frase. */
  description: string;
  /** Quem lê e escreve a tabela. */
  usedBy: string[];
  /** `true` quando guarda texto escrito por pessoas (memórias, prompts) ou segredos cifrados. */
  sensitive: boolean;
}

/** O que cada tabela guarda. Uma tabela sem nota aparece no grupo `system`, sem descrição. */
export const TABLE_NOTES: Record<string, TableNote> = {
  tool: {
    group: 'tools',
    description:
      'O catálogo das ferramentas (sentiment, reply, tipification…). O servidor acrescenta as que implementa ao arrancar.',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: false,
  },
  tool_config: {
    group: 'tools',
    description:
      'A configuração gravada de cada ferramenta: modelo, temperatura, tokens, tempo, ligada ou não e os valores próprios. Sem linha, valem os do código.',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: false,
  },
  tool_config_fallback: {
    group: 'tools',
    description: 'Os modelos de recurso de cada ferramenta, por ordem (até 3).',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: false,
  },
  llm_model: {
    group: 'tools',
    description:
      'Os modelos usados nas configurações (ex.: google/gemini-2.5-flash), ligados ao fornecedor.',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: false,
  },
  ai_provider: {
    group: 'catalogs',
    description: 'Os fornecedores de modelos (hoje só se usa o openrouter).',
    usedBy: ['src/admin/tools.ts'],
    sensitive: false,
  },
  prompt: {
    group: 'prompts',
    description: 'Um registo por ferramenta que tem versões de prompt.',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: false,
  },
  prompt_version: {
    group: 'prompts',
    description:
      'As versões do prompt de sistema de cada ferramenta. Nunca mudam depois de criadas; no máximo uma ativa. Sem versão ativa usa-se o prompt do código.',
    usedBy: ['src/adapters/postgres-store.ts', 'src/admin/tools.ts'],
    sensitive: true,
  },
  memory: {
    group: 'memories',
    description:
      'O texto de cada memória (regra da empresa ou preferência de um utilizador), com o âmbito e a origem.',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: true,
  },
  org_memory: {
    group: 'memories',
    description: 'A que org pertence cada memória da org (id 00D… do Salesforce).',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: false,
  },
  user_memory: {
    group: 'memories',
    description: 'A que utilizador (005…) e org pertence cada memória de utilizador.',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: false,
  },
  memory_tool: {
    group: 'memories',
    description: 'As ferramentas a que cada memória se aplica. Sem linhas, aplica-se a todas.',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: false,
  },
  memory_scope: {
    group: 'catalogs',
    description: 'Os âmbitos das memórias: org ou user.',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: false,
  },
  memory_source: {
    group: 'catalogs',
    description: 'Quem criou a memória: admin (API de administração) ou user (Salesforce).',
    usedBy: ['src/adapters/postgres-memory-store.ts'],
    sensitive: false,
  },
  engine_setting: {
    group: 'settings',
    description:
      'As definições alteradas sem reiniciar (PATCH /v1/admin/settings). Prevalecem sobre o .env; todas as instâncias releem a tabela a cada 30 s.',
    usedBy: ['src/adapters/postgres-settings-store.ts', 'src/settings/settings.ts'],
    sensitive: false,
  },
  org_key: {
    group: 'orgKeys',
    description:
      'As chaves com que cada org assina os pedidos (JWT), cifradas com a ORG_KEY_ENCRYPTION_KEY (AES-256-GCM), com etiqueta, revogação e último uso.',
    usedBy: ['src/adapters/postgres-org-key-store.ts', 'src/auth/org-keys.ts'],
    sensitive: true,
  },
  schema_migration: {
    group: 'system',
    description: 'As migrações aplicadas (nome, checksum e data). Escrita por npm run migrate.',
    usedBy: ['src/db/migrate.ts'],
    sensitive: false,
  },
};

export interface DatabaseColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface DatabaseForeignKey {
  columns: string[];
  references: { table: string; columns: string[] };
}

export interface DatabaseTable extends Omit<TableNote, 'group'> {
  name: string;
  group: TableGroup;
  /** Linhas contadas agora (`null` se a contagem falhou). */
  rows: number | null;
  /** Tamanho em disco, com índices, em bytes. */
  bytes: number;
  columns: DatabaseColumn[];
  primaryKey: string[];
  foreignKeys: DatabaseForeignKey[];
}

export interface DatabaseReport {
  generatedAt: string;
  /** O schema onde a IRIS tem as tabelas (normalmente `public`). */
  schema: string;
  /** A versão do Postgres, ex.: `16.4`. */
  serverVersion: string;
  /** Tamanho da base de dados inteira, em bytes. */
  totalBytes: number;
  groups: readonly TableGroup[];
  tables: DatabaseTable[];
  migrations: { name: string; appliedAt: string }[];
}

interface TableRow {
  name: string;
  rows: string | null;
  bytes: string;
}
interface ColumnRow {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
}
interface ConstraintRow {
  table: string;
  kind: 'p' | 'f';
  columns: string[];
  ref_table: string | null;
  ref_columns: string[] | null;
}

/** Lê o catálogo do Postgres. As contagens são exatas (as tabelas da IRIS são pequenas). */
export async function describeDatabase(pool: Pool, now = new Date()): Promise<DatabaseReport> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Uma contagem lenta não pode prender a consola.
    await client.query("SET LOCAL statement_timeout = '3s'");
    const meta = await client.query<{ schema: string; version: string; bytes: string }>(
      `SELECT current_schema() AS schema,
              current_setting('server_version') AS version,
              pg_database_size(current_database())::text AS bytes`,
    );
    const tables = await client.query<TableRow>(
      `SELECT t.table_name AS name,
              (xpath('/row/c/text()',
                     query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.table_schema, t.table_name),
                                  false, true, '')))[1]::text AS rows,
              pg_total_relation_size(format('%I.%I', t.table_schema, t.table_name)::regclass)::text AS bytes
         FROM information_schema.tables t
        WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`,
    );
    const columns = await client.query<ColumnRow>(
      `SELECT table_name AS table, column_name AS name, data_type AS type,
              is_nullable = 'YES' AS nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
        ORDER BY table_name, ordinal_position`,
    );
    const constraints = await client.query<ConstraintRow>(
      `SELECT c.conrelid::regclass::text AS table, c.contype AS kind,
              array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                     ORDER BY k.i)::text[] AS columns,
              CASE WHEN c.contype = 'f' THEN c.confrelid::regclass::text END AS ref_table,
              CASE WHEN c.contype = 'f' THEN
                array(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n
                       ORDER BY k.i)::text[] END AS ref_columns
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema() AND c.contype IN ('p', 'f')
        ORDER BY 1, c.conname`,
    );
    const hasMigrations = tables.rows.some((t) => t.name === 'schema_migration');
    const migrations = hasMigrations
      ? await client.query<{ name: string; applied_at: Date }>(
          'SELECT name, applied_at FROM schema_migration ORDER BY name',
        )
      : { rows: [] };
    await client.query('COMMIT');

    // `regclass::text` pode vir com o schema à frente quando não está no search_path.
    const bare = (name: string): string => name.replace(/^.*\./, '').replace(/"/g, '');

    return {
      generatedAt: now.toISOString(),
      schema: meta.rows[0]?.schema ?? 'public',
      serverVersion: meta.rows[0]?.version ?? '',
      totalBytes: Number(meta.rows[0]?.bytes ?? 0),
      groups: TABLE_GROUPS,
      tables: tables.rows.map((t) => {
        const note = TABLE_NOTES[t.name];
        const own = constraints.rows.filter((c) => bare(c.table) === t.name);
        return {
          name: t.name,
          group: note?.group ?? 'system',
          description: note?.description ?? '',
          usedBy: note?.usedBy ?? [],
          sensitive: note?.sensitive ?? false,
          rows: t.rows === null ? null : Number(t.rows),
          bytes: Number(t.bytes),
          columns: columns.rows
            .filter((c) => c.table === t.name)
            .map(({ name, type, nullable }) => ({ name, type, nullable })),
          primaryKey: own.find((c) => c.kind === 'p')?.columns ?? [],
          foreignKeys: own
            .filter((c) => c.kind === 'f')
            .map((c) => ({
              columns: c.columns,
              references: { table: bare(c.ref_table ?? ''), columns: c.ref_columns ?? [] },
            })),
        };
      }),
      migrations: migrations.rows.map((m) => ({
        name: m.name,
        appliedAt: m.applied_at.toISOString(),
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
