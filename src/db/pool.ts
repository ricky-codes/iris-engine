import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Um erro numa ligação ociosa não pode derrubar o processo.
  pool.on('error', (err) => {
    console.error('postgres: erro numa ligação ociosa', err.message);
  });
  return pool;
}
