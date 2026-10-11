import type { Pool } from 'pg';
import { AppError } from '../http/errors.js';

const SF_USER_REF = /^005[A-Za-z0-9]{15}$/;

/**
 * Devolve o utilizador da org. Só um administrador cria utilizadores, por isso um
 * `userId` desconhecido é recusado (403) e nada é criado. A org já foi provada pela
 * chave; o `userId` do corpo só identifica quem, dentro dela, faz o pedido.
 */
export async function requireOrgUser(
  pool: Pool,
  sfOrgId: string,
  sfUserRef: string,
): Promise<string> {
  if (!SF_USER_REF.test(sfUserRef)) {
    throw new AppError('invalid_request', 422, 'O pedido não é válido.', [
      { path: 'body.userId', issue: 'deve ser um id Salesforce de utilizador com 18 caracteres' },
    ]);
  }

  const { rows } = await pool.query<{ org_user_id: string }>(
    'SELECT org_user_id FROM org_user WHERE sf_org_id = $1 AND sf_user_ref = $2',
    [sfOrgId, sfUserRef],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('user_not_registered', 403, 'O utilizador não está registado na IRIS.');
  }
  return row.org_user_id;
}
