import type { ToolDefaults } from './tool.js';

export interface ToolSettings extends ToolDefaults {
  model: string;
  /** Modelos de recurso, por ordem: experimentam-se quando o principal falha. Máximo 3. */
  fallbackModels: string[];
  enabled: boolean;
  /** Prompt ativo na base de dados, se existir. Senão usa-se o da ferramenta. */
  systemPrompt: string | undefined;
}

/** O modelo e os modelos de recurso de quem não tem configuração na base de dados. */
export interface ModelDefaults {
  model: string;
  fallbackModels: string[];
}

/** A configuração de cada ferramenta que o motor lê em cada pedido. Nunca escreve. */
export interface EngineStore {
  settingsFor(tool: string, defaults: ToolDefaults, models: ModelDefaults): Promise<ToolSettings>;
}

/** O modelo principal nunca é também de recurso, e cada modelo aparece uma só vez. */
export function fallbackChain(model: string, fallbackModels: readonly string[]): string[] {
  return [...new Set(fallbackModels)].filter((m) => m !== model);
}
