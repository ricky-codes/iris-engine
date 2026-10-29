import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Memories } from '../src/engine/memory.js';
import { fakeMemoryStore } from './engine/fakes.js';
import { buildTestApp } from './helpers.js';

const SECRET = 's'.repeat(40);
const AUTH = { authorization: `Bearer ${SECRET}` };
const ORG = '00DAAAAAAAAAAAAAAA';
const ME = '005AAAAAAAAAAAAAAA';
const COLLEAGUE = '005BBBBBBBBBBBBBBB';
const OWNER = `orgId=${ORG}&userId=${ME}`;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const { store, rows } = fakeMemoryStore();
  const memories = new Memories(store);
  app = await buildTestApp({ memories: { memories, apiSecret: SECRET } });
  return { app, memories, rows };
}

describe('/v1/memories', () => {
  it('sem credencial dá 401, antes de validar o pedido', async () => {
    const { app } = await start();
    for (const req of [
      { method: 'GET' as const, url: '/v1/memories' },
      { method: 'POST' as const, url: '/v1/memories', payload: {} },
      { method: 'DELETE' as const, url: '/v1/memories/x' },
    ]) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(401);
    }
  });

  it('cria uma memória do utilizador, sem espaços à volta', async () => {
    const { app, rows } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/memories',
      headers: AUTH,
      payload: { orgId: ORG, userId: ME, content: '  Respostas curtas.  ', tools: ['sentiment'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      scope: 'user',
      content: 'Respostas curtas.',
      tools: ['sentiment'],
    });
    expect([...rows.values()][0]).toMatchObject({ source: 'user', orgId: ORG, userId: ME });
  });

  it('recusa texto longo, ids que não são do Salesforce e campos a mais', async () => {
    const { app, rows } = await start();
    for (const payload of [
      { orgId: ORG, userId: ME, content: 'x'.repeat(501) },
      { orgId: 'org', userId: ME, content: 'x' },
      { orgId: ORG, userId: ME, content: 'x', scope: 'org' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/memories', headers: AUTH, payload });
      expect(res.statusCode).toBe(422);
    }
    expect(rows.size).toBe(0);
  });

  it('mostra as regras da org e as do utilizador, nunca as de um colega', async () => {
    const { app, memories } = await start();
    await memories.remember({ owner: { orgId: ORG }, source: 'admin', content: 'regra' });
    await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: 'minha',
    });
    await memories.remember({
      owner: { orgId: ORG, userId: COLLEAGUE },
      source: 'user',
      content: 'do colega',
    });

    const res = await app.inject({ method: 'GET', url: `/v1/memories?${OWNER}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ org: { content: string }[]; user: { content: string }[] }>();
    expect(body.org.map((m) => m.content)).toEqual(['regra']);
    expect(body.user.map((m) => m.content)).toEqual(['minha']);
    expect(body).toMatchObject({ limits: { user: { count: 1, limit: 20 } } });
  });

  it('filtra por ferramenta, mas o limite conta todas as memórias do utilizador', async () => {
    const { app, memories } = await start();
    const me = { orgId: ORG, userId: ME };
    await memories.remember({ owner: me, source: 'user', content: 'todas' });
    await memories.remember({ owner: me, source: 'user', content: 'só reply', tools: ['reply'] });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/memories?${OWNER}&tool=sentiment`,
      headers: AUTH,
    });
    const body = res.json<{ user: { content: string }[] }>();
    expect(body.user.map((m) => m.content)).toEqual(['todas']);
    expect(body).toMatchObject({ limits: { user: { count: 2 } } });
  });

  it('apaga uma memória do próprio utilizador', async () => {
    const { app, memories, rows } = await start();
    const m = await memories.remember({
      owner: { orgId: ORG, userId: ME },
      source: 'user',
      content: 'minha',
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/memories/${m.id}?${OWNER}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(rows.size).toBe(0);
  });

  it('não apaga as regras da org nem as de um colega: dá 404, como se não existissem', async () => {
    const { app, memories, rows } = await start();
    const org = await memories.remember({ owner: { orgId: ORG }, source: 'admin', content: 'a' });
    const theirs = await memories.remember({
      owner: { orgId: ORG, userId: COLLEAGUE },
      source: 'user',
      content: 'b',
    });
    for (const id of [org.id, theirs.id]) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/memories/${id}?${OWNER}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(rows.size).toBe(2);
  });
});
