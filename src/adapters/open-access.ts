import type { AccessChecker } from '../engine/access.js';

/**
 * Deixa passar todos os pedidos. Quem chega ao motor já passou pela credencial da API
 * (`API_SECRET`): é ela que controla o acesso. Usado com `ACCESS_MODE=open` e com
 * `STEPACCESS_BYPASS` (este só fora de produção).
 */
export class OpenAccessChecker implements AccessChecker {
  async check(): Promise<void> {
    // Intencionalmente vazio.
  }
}
