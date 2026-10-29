import { describe, expect, it } from 'vitest';
import { MAX_MEMORY_CHARS, Memories } from '../../src/engine/memory.js';
import { fakeMemoryStore as memoryStore } from './fakes.js';

const ORG = '00D000000000000AAA';
const ME = '005000000000000AAA';
const COLLEAGUE = '005000000000000BBB';

describe('memórias no núcleo', () => {
  it('guarda sem espaços à volta e sem ferramentas repetidas', async () => {
    const memories = new Memories(memoryStore().store);
    const m = await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: '  Respostas curtas.  ',
      tools: ['reply', 'reply'],
    });
    expect(m).toMatchObject({
      scope: 'user',
      orgId: ORG,
      userId: ME,
      content: 'Respostas curtas.',
      tools: ['reply'],
    });
  });

  it.each([
    ['vazio', '   '],
    ['longo demais', 'x'.repeat(MAX_MEMORY_CHARS + 1)],
  ])('recusa texto %s, sem gravar nada', async (_label, content) => {
    const { store, rows } = memoryStore();
    await expect(
      new Memories(store).remember({ owner: { orgId: ORG }, source: 'admin', content }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(rows.size).toBe(0);
  });

  it('só altera memórias da org', async () => {
    const memories = new Memories(memoryStore().store);
    const org = await memories.remember({ owner: { orgId: ORG }, source: 'admin', content: 'a' });
    const mine = await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: 'b',
    });
    expect(await memories.update(org.id, { content: ' novo ' })).toMatchObject({ content: 'novo' });
    await expect(memories.update(mine.id, { content: 'c' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(memories.update('nao-existe', { content: 'c' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('um utilizador só apaga as suas; as de outros contam como inexistentes', async () => {
    const memories = new Memories(memoryStore().store);
    const org = await memories.remember({ owner: { orgId: ORG }, source: 'admin', content: 'a' });
    const theirs = await memories.remember({
      owner: { orgId: ORG, userId: COLLEAGUE },
      source: 'user',
      content: 'b',
    });
    const mine = await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: 'c',
    });
    const me = { orgId: ORG, userId: ME };

    await expect(memories.forget(org.id, me)).rejects.toMatchObject({ code: 'not_found' });
    await expect(memories.forget(theirs.id, me)).rejects.toMatchObject({ code: 'not_found' });
    await memories.forget(mine.id, me);
    expect(await memories.get(mine.id)).toBeUndefined();
    expect(await memories.get(theirs.id)).toBeDefined();
  });

  it('sem dono indicado (administração), apaga qualquer uma e avisa se já não existe', async () => {
    const memories = new Memories(memoryStore().store);
    const m = await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: 'a',
    });
    await memories.forget(m.id);
    await expect(memories.forget(m.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
