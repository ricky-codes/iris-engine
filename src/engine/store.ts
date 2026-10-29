import type { ToolDefaults } from './tool.js';

export interface RequestMemories {
  /** Regras da empresa. Prevalecem sobre as do utilizador. */
  org: string[];
  /** Preferências do próprio utilizador. */
  user: string[];
}

export interface ToolSettings extends ToolDefaults {
  model: string;
  enabled: boolean;
  /** Prompt ativo na base de dados, se existir. Senão usa-se o da ferramenta. */
  systemPrompt: string | undefined;
}

/** O que o motor lê da base de dados em cada pedido. Nunca escreve. */
export interface EngineStore {
  memoriesFor(request: { orgId: string; userId: string; tool: string }): Promise<RequestMemories>;
  settingsFor(tool: string, defaults: ToolDefaults, defaultModel: string): Promise<ToolSettings>;
}
