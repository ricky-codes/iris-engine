import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const pool = config.databaseUrl === undefined ? undefined : createPool(config.databaseUrl);

  const app = await buildApp({
    config,
    readinessChecks:
      pool === undefined
        ? []
        : [
            {
              name: 'database',
              check: async () => {
                await pool.query('SELECT 1');
              },
            },
          ],
  });
  if (pool !== undefined) app.addHook('onClose', async () => pool.end());

  // Encerramento ordenado: deixa de aceitar pedidos e termina os que estão em curso.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
