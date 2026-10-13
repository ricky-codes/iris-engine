import { createHash, timingSafeEqual } from 'node:crypto';
import { Type, type TObject } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { runTool, type EngineDeps } from '../../engine/run.js';
import type { ToolDefinition } from '../../engine/tool.js';
import { AppError } from '../errors.js';

export interface ToolRoutesOptions {
  tools: ToolDefinition[];
  deps: EngineDeps;
  apiSecret: string;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compara em tempo constante (os hashes têm sempre o mesmo tamanho). */
function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

const unauthorized = (): AppError =>
  new AppError('unauthorized', 401, 'Credenciais inválidas.', [], {
    'WWW-Authenticate': 'Bearer',
  });

/** Campos comuns a todos os pedidos. Os ids vêm do Salesforce, sempre com 18 caracteres. */
const Envelope = {
  orgId: Type.String({ pattern: '^00D[A-Za-z0-9]{15}$' }),
  userId: Type.String({ pattern: '^005[A-Za-z0-9]{15}$' }),
};

function bodySchema(tool: ToolDefinition): TObject {
  return Type.Object(
    {
      ...Envelope,
      version: Type.Optional(Type.Literal(tool.version)),
      ...tool.input.properties,
    },
    { additionalProperties: false },
  );
}

/**
 * `POST /v1/tools/<nome>` para cada ferramenta e `GET /v1/tools` para as listar.
 * A autenticação corre antes da validação do corpo: sem credencial não se revela nada.
 */
export const toolRoutes: FastifyPluginAsyncTypebox<ToolRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match?.[1] === undefined || !secretMatches(match[1], opts.apiSecret)) throw unauthorized();
  });

  app.get('/v1/tools', async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
    })),
  }));

  for (const tool of opts.tools) {
    app.post(`/v1/tools/${tool.name}`, { schema: { body: bodySchema(tool) } }, async (request) => {
      const body = request.body as Record<string, unknown> & { orgId: string; userId: string };
      const { orgId, userId } = body;
      // A entrada da ferramenta é o corpo sem os campos comuns.
      const input = Object.fromEntries(
        Object.entries(body).filter(([k]) => k !== 'orgId' && k !== 'userId' && k !== 'version'),
      );

      const started = performance.now();
      const { result, meta } = await runTool(opts.deps, tool, { orgId, userId, input });
      request.log.info(
        { tool: tool.name, ...meta, durationMs: Math.round(performance.now() - started) },
        'tool completed',
      );
      return { tool: tool.name, version: tool.version, result };
    });
  }

  app.post('/v1/tools/:name', async () => {
    throw new AppError('unknown_tool', 404, 'Ferramenta desconhecida.');
  });
};
