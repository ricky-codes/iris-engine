export interface AccessRequest {
  orgId: string;
  userId: string;
}

/** Pergunta se o utilizador pode usar a IRIS agora. Lança `EngineError` se não puder. */
export interface AccessChecker {
  check(request: AccessRequest): Promise<void>;
}
