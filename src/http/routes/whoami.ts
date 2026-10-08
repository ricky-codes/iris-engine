import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { requireAuth } from '../../auth/authenticate.js';

const WhoamiResponse = Type.Object({
  tenant: Type.Object({ slug: Type.String(), name: Type.String() }),
  org: Type.Object({ orgId: Type.String(), isSandbox: Type.Boolean() }),
});

/**
 * Diz a que cliente e org pertence a chave usada. Serve para testar a ligação e a
 * credencial (por exemplo, a Named Credential no Salesforce) sem enviar um Case.
 */
export const whoamiRoutes: FastifyPluginAsyncTypebox<{
  authenticate: (request: FastifyRequest) => Promise<void>;
}> = async (app, opts) => {
  app.get(
    '/v1/whoami',
    { onRequest: opts.authenticate, schema: { response: { 200: WhoamiResponse } } },
    async (request) => {
      const auth = requireAuth(request);
      return {
        tenant: { slug: auth.tenant.slug, name: auth.tenant.name },
        org: { orgId: auth.org.sfOrgRef, isSandbox: auth.org.isSandbox },
      };
    },
  );
};
