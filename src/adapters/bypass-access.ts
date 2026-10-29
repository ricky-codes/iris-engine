import type { AccessChecker } from '../engine/access.js';

/** Sem StepAccess: deixa passar tudo. Só para desenvolvimento (proibido em produção). */
export class BypassAccessChecker implements AccessChecker {
  async check(): Promise<void> {
    // Intencionalmente vazio.
  }
}
