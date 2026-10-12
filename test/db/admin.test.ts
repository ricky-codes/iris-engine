import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminApi } from '../../src/admin/api.js';
import {
  AdminError,
  createOrgMemory,
  deleteMemoriesOf,
  deleteMemory,
} from '../../src/admin/commands.js';
import { listMemories, listTools } from '../../src/admin/queries.js';
import { TEST_DATABASE_URL, addMemory, createTestDb, sfId, type TestDb } from './helpers.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('administração das memórias', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('cria uma memória da org, com origem admin e para todas as ferramentas', async () => {
    const org = sfId('00D');
    const { memoryId } = await createOrgMemory(db.pool, {
      sfOrgRef: org,
      content: '  Tratar por você.  ',
    });
    const [m] = await listMemories(db.pool, { sfOrgRef: org });
    expect(m).toMatchObject({
      memoryId,
      scope: 'org',
      source: 'admin',
      sfOrgRef: org,
      sfUserRef: null,
      content: 'Tratar por você.',
      tools: [],
    });
  });

  it('pode limitar a memória a ferramentas', async () => {
    const org = sfId('00D');
    await createOrgMemory(db.pool, {
      sfOrgRef: org,
      content: 'Curto.',
      tools: ['sentiment', 'reply', 'reply'],
    });
    const [m] = await listMemories(db.pool, { sfOrgRef: org });
    expect(m?.tools).toEqual(['reply', 'sentiment']);
  });

  it('recusa ferramenta desconhecida, id inválido e texto longo, sem gravar nada', async () => {
    const org = sfId('00D');
    await expect(
      createOrgMemory(db.pool, { sfOrgRef: org, content: 'x', tools: ['nao-existe'] }),
    ).rejects.toThrow(/Ferramenta desconhecida/);
    await expect(createOrgMemory(db.pool, { sfOrgRef: '00Dx', content: 'x' })).rejects.toThrow(
      /org-id/,
    );
    await expect(
      createOrgMemory(db.pool, { sfOrgRef: org, content: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(await listMemories(db.pool, { sfOrgRef: org })).toEqual([]);
  });

  it('explica o limite de 50 memórias por org', async () => {
    const org = sfId('00D');
    for (let i = 0; i < 50; i++) await addMemory(db.pool, { org }, `m${String(i)}`);
    await expect(createOrgMemory(db.pool, { sfOrgRef: org, content: 'a mais' })).rejects.toThrow(
      /já tem 50 memórias/,
    );
  });

  it('lista a org primeiro e filtra por org e utilizador', async () => {
    const org = sfId('00D');
    const user = sfId('005');
    await addMemory(db.pool, { org, user }, 'do utilizador');
    await addMemory(db.pool, { org }, 'da org');
    await addMemory(db.pool, { org: sfId('00D') }, 'de outra org');

    const all = await listMemories(db.pool, { sfOrgRef: org });
    expect(all.map((m) => m.content)).toEqual(['da org', 'do utilizador']);
    expect(all[1]).toMatchObject({ scope: 'user', source: 'user', sfUserRef: user });

    const mine = await listMemories(db.pool, { sfOrgRef: org, sfUserRef: user });
    expect(mine.map((m) => m.content)).toEqual(['do utilizador']);
  });

  it('apaga uma memória, e avisa se já não existe', async () => {
    const id = await addMemory(db.pool, { org: sfId('00D') });
    await deleteMemory(db.pool, { memoryId: id });
    await expect(deleteMemory(db.pool, { memoryId: id })).rejects.toThrow(/já não existe/);
  });

  it('apaga as memórias de quem sai: de um utilizador, ou de uma org inteira', async () => {
    const org = sfId('00D');
    const leaving = sfId('005');
    const staying = sfId('005');
    await addMemory(db.pool, { org, user: leaving }, 'a');
    await addMemory(db.pool, { org, user: leaving }, 'b');
    await addMemory(db.pool, { org, user: staying }, 'c');
    await addMemory(db.pool, { org }, 'd');
    const other = sfId('00D');
    await addMemory(db.pool, { org: other }, 'e');

    expect(await deleteMemoriesOf(db.pool, { sfOrgRef: org, sfUserRef: leaving })).toBe(2);
    expect((await listMemories(db.pool, { sfOrgRef: org })).map((m) => m.content)).toEqual([
      'd',
      'c',
    ]);

    expect(await deleteMemoriesOf(db.pool, { sfOrgRef: org })).toBe(2);
    expect(await listMemories(db.pool, { sfOrgRef: org })).toEqual([]);
    expect(await listMemories(db.pool, { sfOrgRef: other })).toHaveLength(1);
  });

  it('a API da interface carrega memórias e ferramentas', async () => {
    const org = sfId('00D');
    const api = createAdminApi(db.pool);
    await api.createOrgMemory({ sfOrgRef: org, content: 'Pela API.', tools: [] });
    const data = await api.load();
    expect(data.tools).toEqual(await listTools(db.pool));
    const m = data.memories.find((x) => x.sfOrgRef === org);
    expect(m?.content).toBe('Pela API.');
    await api.deleteMemory(m?.memoryId ?? '');
    expect((await api.load()).memories.some((x) => x.sfOrgRef === org)).toBe(false);
  });
});
