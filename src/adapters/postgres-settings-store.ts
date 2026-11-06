import type { Pool } from 'pg';
import type { SettingKey, SettingsStore, StoredSetting } from '../settings/settings.js';

/** As definições na tabela `engine_setting` (migração 0011). */
export class PgSettingsStore implements SettingsStore {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<StoredSetting[]> {
    const { rows } = await this.pool.query<{
      key: string;
      value: unknown;
      updated_at: Date;
      updated_by: string;
    }>('SELECT key, value, updated_at, updated_by FROM engine_setting');
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  }

  /** Grava e apaga numa só transação: duas escritas, sejam quantas forem as definições. */
  async save(changes: { key: SettingKey; value: unknown }[], actor: string): Promise<void> {
    const set = changes.filter((c) => c.value !== null);
    const reset = changes.filter((c) => c.value === null).map((c) => c.key);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (set.length > 0) {
        await client.query(
          `INSERT INTO engine_setting (key, value, updated_by)
           SELECT key, value, $3 FROM unnest($1::text[], $2::jsonb[]) AS s(key, value)
           ON CONFLICT (key) DO UPDATE SET
             value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [set.map((c) => c.key), set.map((c) => JSON.stringify(c.value)), actor],
        );
      }
      if (reset.length > 0) {
        await client.query('DELETE FROM engine_setting WHERE key = ANY($1::text[])', [reset]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
