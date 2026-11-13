import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signOrgToken, verifyOrgToken, type OrgSigningKey } from '../src/auth/org-token.js';
import type { TokenVerifier } from '../src/http/auth.js';
import { DEFAULT_MEMORY_LIMITS, Memories } from '../src/engine/memory.js';
import type { ToolDefinition } from '../src/engine/tool.js';
import { diagnosticTool } from '../src/tools/diagnostic.js';
import { fakeAccess, fakeEngine, fakeLlm, fakeMemoryStore, fakeStore } from './engine/fakes.js';
import { buildTestApp } from './helpers.js';

const ORG = '00DAAAAAAAAAAAAAAA';
const USER = '005AAAAAAAAAAAAAAA';
const KEY: OrgSigningKey = {
  kid: 'k_0123456789abcdef',
  orgId: ORG,
  secret: 'segredo-da-org-1234567890',
};

/** Verifica com a chave fixa, ao relógio real, e lembra-se dos jti usados. */
function verifier(): TokenVerifier {
  const seen = new Set<string>();
  return {
    verify: async (token) =>
      verifyOrgToken(token, KEY, Math.floor(Date.now() / 1000), (org, jti) => {
        const id = `${org}:${jti}`;
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      }),
  };
}

let counter = 0;
const bearer = (key = KEY, userId = USER) => ({
  authorization: `Bearer ${signOrgToken(key, {
    userId,
    jti: `pedido-${String(++counter).padStart(6, '0')}`,
    iat: Math.floor(Date.now() / 1000),
    ttlSeconds: 60,
  })}`,
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const access = fakeAccess();
  const { store, rows } = fakeMemoryStore();
  const orgKeys = verifier();
  app = await buildTestApp({
    engine: {
      orgKeys,
      engine: fakeEngine([diagnosticTool as unknown as ToolDefinition], {
        access: access.access,
        llm: fakeLlm('{"reply":"Olá!"}').llm,
        ...fakeStore(),
      }),
    },
    memories: { orgKeys, memories: new Memories(store, () => DEFAULT_MEMORY_LIMITS) },
  });
  return { app, access, rows };
}

describe('rotas públicas com tokens das orgs', () => {
  it('a org e o utilizador vêm do token e chegam ao StepAccess', async () => {
    const { app, access } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: bearer(),
      payload: { message: 'Olá' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: { reply: 'Olá!' } });
    expect(access.calls).toEqual([{ orgId: ORG, userId: USER }]);
  });

  it('o orgId e o userId não podem vir no corpo', async () => {
    const { app, access } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers: bearer(),
      payload: { orgId: '00DBBBBBBBBBBBBBBB', userId: USER, message: 'Olá' },
    });
    expect(res.statusCode).toBe(422);
    expect(access.calls).toHaveLength(0);
  });

  it.each([
    ['sem cabeçalho', {}],
    ['o segredo partilhado antigo', { authorization: `Bearer ${'s'.repeat(40)}` }],
    ['assinado com outro segredo', bearer({ ...KEY, secret: 'outro-segredo-qualquer' })],
  ])('401 com %s, antes de validar o corpo', async (_l, headers) => {
    const { app, access } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/diagnostic',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(access.calls).toHaveLength(0);
  });

  it('um token só serve para um pedido', async () => {
    const { app } = await start();
    const headers = bearer();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/tools/diagnostic',
        headers,
        payload: { message: 'Olá' },
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(401);
  });

  it('memórias: criar, ver e apagar com a identidade do token', async () => {
    const { app, rows } = await start();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/memories',
      headers: bearer(),
      payload: { content: 'Respostas curtas.' },
    });
    expect(created.statusCode).toBe(201);
    expect([...rows.values()][0]).toMatchObject({ orgId: ORG, userId: USER });

    const list = await app.inject({ method: 'GET', url: '/v1/memories', headers: bearer() });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ user: [{ content: 'Respostas curtas.' }] });

    // Os ids na query string já não são aceites.
    const withIds = await app.inject({
      method: 'GET',
      url: `/v1/memories?orgId=${ORG}&userId=${USER}`,
      headers: bearer(),
    });
    expect(withIds.statusCode).toBe(422);

    const id = created.json<{ id: string }>().id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/memories/${id}`,
      headers: bearer(),
    });
    expect(del.statusCode).toBe(204);
  });

  it('memórias: um colega da mesma org não apaga as minhas', async () => {
    const { app } = await start();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/memories',
      headers: bearer(),
      payload: { content: 'Só minha.' },
    });
    const id = created.json<{ id: string }>().id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/memories/${id}`,
      headers: bearer(KEY, '005BBBBBBBBBBBBBBB'),
    });
    expect(del.statusCode).toBe(404);
  });
});
