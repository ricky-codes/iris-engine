import type { Pool, PoolClient } from 'pg';
import type { LeaderLock } from '../alerts/monitor.js';

/**
 * Com várias instâncias, só a que tem o bloqueio consultivo do Postgres avalia e envia alertas.
 * O bloqueio é de sessão: fica numa ligação dedicada enquanto esta instância for a escolhida,
 * e solta-se sozinho se a ligação cair (outra instância fica com ele na avaliação seguinte).
 */
export class PgLeaderLock implements LeaderLock {
  private client: PoolClient | undefined;
  private held = false;

  constructor(
    private readonly pool: Pool,
    private readonly name = 'iris-engine:alerts',
  ) {}

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [this.name],
      );
      if (rows[0]?.ok !== true) {
        client.release();
        return false;
      }
      this.client = client;
      this.held = true;
      client.on('error', () => {
        this.lose();
      });
      return true;
    } catch {
      client?.release(true);
      this.lose();
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [this.name])
      .catch(() => undefined);
    this.lose();
  }

  private lose(): void {
    this.client?.release(true);
    this.client = undefined;
    this.held = false;
  }
}
