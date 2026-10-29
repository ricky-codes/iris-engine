import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PgMemoryStore } from '../../src/adapters/postgres-memory-store.js';
import { syncToolCatalog } from '../../src/adapters/postgres-store.js';
import { Memories } from '../../src/engine/memory.js';
import { buildTestApp } from '../helpers.js';
import { TEST_DATABASE_URL, addMemory, createTestDb, sfId, type TestDb } from './helpers.js';

const SECRET = 's'.repeat(40);
const AUTH = { authorization: `Bearer ${SECRET}` };

describe.skipIf(TEST_DATABASE_URL === undefined)('/v1/memories contra o Postgres', () => {
  let db: TestDb;
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    db = await createTestDb();
    await syncToolCatalog(db.pool, ['sentiment']);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await db.close();
  });

  it('cria, lista e apaga as memórias do utilizador, com as regras da org à parte', async () => {
    const memories = new Memories(new PgMemoryStore(db.pool));
    app = await buildTestApp({ memories: { memories, apiSecret: SECRET } });
    const org = sfId('00D');
    const me = sfId('005');
    await addMemory(db.pool, { org }, 'regra da org');
    await addMemory(db.pool, { org, user: sfId('005') }, 'de um colega');
    await addMemory(db.pool, { org: sfId('00D') }, 'de outra org');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/memories',
      headers: AUTH,
      payload: { orgId: org, userId: me, content: 'Só no sentimento.', tools: ['sentiment'] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    const unknownTool = await app.inject({
      method: 'POST',
      url: '/v1/memories',
      headers: AUTH,
      payload: { orgId: org, userId: me, content: 'x', tools: ['nao_existe'] },
    });
    expect(unknownTool.statusCode).toBe(422);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/memories?orgId=${org}&userId=${me}&tool=sentiment`,
      headers: AUTH,
    });
    expect(list.json()).toMatchObject({
      org: [{ content: 'regra da org', scope: 'org' }],
      user: [{ id, content: 'Só no sentimento.', scope: 'user', tools: ['sentiment'] }],
      limits: { user: { count: 1, limit: 20 } },
    });
    expect(list.json<{ org: unknown[]; user: unknown[] }>().org).toHaveLength(1);
    expect(list.json<{ org: unknown[]; user: unknown[] }>().user).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/memories/${id}?orgId=${org}&userId=${me}`,
      headers: AUTH,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await memories.get(id)).toBeUndefined();
  });
});
