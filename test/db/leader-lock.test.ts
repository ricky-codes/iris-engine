import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgLeaderLock } from '../../src/adapters/pg-leader-lock.js';
import { TEST_DATABASE_URL, createTestDb, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('bloqueio dos alertas', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('só uma instância avalia; quando a primeira sai, outra fica com o bloqueio', async () => {
    const name = `iris-engine:alerts:${String(Date.now())}`;
    const a = new PgLeaderLock(db.pool, name);
    const b = new PgLeaderLock(db.pool, name);
    expect(await a.acquire()).toBe(true);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });
});
