import { ConfigError, loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databaseUrl === undefined) {
    throw new ConfigError(['DATABASE_URL: obrigatório para migrar']);
  }

  const pool = createPool(config.databaseUrl);
  try {
    const { applied, skipped } = await runMigrations(pool, config.migrationsDir);
    for (const name of applied) console.log(`aplicada  ${name}`);
    for (const name of skipped) console.log(`ignorada  ${name}`);
    console.log(`${applied.length} aplicada(s), ${skipped.length} já existente(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
