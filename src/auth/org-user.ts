import type { Pool } from 'pg';
import { AppError } from '../http/errors.js';

const SF_USER_REF = /^005[A-Za-z0-9]{15}$/;

/**
 * Devolve o utilizador da org, criando-o no primeiro pedido. A org já foi provada pela
 * chave; o `userId` do corpo só identifica quem, dentro dela, fez o pedido.
 */
export async function ensureOrgUser(
  pool: Pool,
  sfOrgId: string,
  sfUserRef: string,
): Promise<string> {
  if (!SF_USER_REF.test(sfUserRef)) {
    throw new AppError('invalid_request', 422, 'O pedido não é válido.', [
      { path: 'body.userId', issue: 'deve ser um id Salesforce de utilizador com 18 caracteres' },
    ]);
  }

  // O `DO UPDATE` não altera nada: só serve para o RETURNING devolver a linha existente.
  const { rows } = await pool.query<{ org_user_id: string }>(
    `INSERT INTO org_user (sf_org_id, sf_user_ref) VALUES ($1, $2)
     ON CONFLICT (sf_org_id, sf_user_ref) DO UPDATE SET sf_user_ref = EXCLUDED.sf_user_ref
     RETURNING org_user_id`,
    [sfOrgId, sfUserRef],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT de org_user não devolveu linha');
  return row.org_user_id;
}
