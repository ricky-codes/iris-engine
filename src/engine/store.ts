import type { ToolDefaults } from './tool.js';

export interface ToolSettings extends ToolDefaults {
  model: string;
  enabled: boolean;
  /** Prompt ativo na base de dados, se existir. Senão usa-se o da ferramenta. */
  systemPrompt: string | undefined;
}

/** A configuração de cada ferramenta que o motor lê em cada pedido. Nunca escreve. */
export interface EngineStore {
  settingsFor(tool: string, defaults: ToolDefaults, defaultModel: string): Promise<ToolSettings>;
}
