import type { ToolDefaults } from './tool.js';

/**
 * As definições do motor que uma ferramenta pode substituir (colunas de `tool_config`).
 * `null` ou ausente: vale a definição global (`/v1/admin/settings`).
 */
export interface ToolOverrides {
  maxAttempts: number | null;
  totalTimeoutMs: number | null;
  rateLimitPerMinute: number | null;
  streamEnabled: boolean | null;
}

export const OVERRIDE_KEYS = [
  'maxAttempts',
  'totalTimeoutMs',
  'rateLimitPerMinute',
  'streamEnabled',
] as const satisfies readonly (keyof ToolOverrides)[];

export const noOverrides = (): ToolOverrides => ({
  maxAttempts: null,
  totalTimeoutMs: null,
  rateLimitPerMinute: null,
  streamEnabled: null,
});

/** O que a configuração gravada diz de uma ferramenta. */
export interface StoredToolSettings extends ToolDefaults {
  model: string;
  /** Modelos de recurso, por ordem: experimentam-se quando o principal falha. Máximo 3. */
  fallbackModels: string[];
  enabled: boolean;
  /** Prompt ativo na base de dados, se existir. Senão usa-se o da ferramenta. */
  systemPrompt: string | undefined;
  /** As definições globais que esta ferramenta substitui. Ausente: nenhuma. */
  overrides?: Partial<ToolOverrides>;
}

/** A configuração em vigor num pedido: a gravada, mais as definições do motor já resolvidas. */
export interface ToolSettings extends StoredToolSettings {
  overrides: ToolOverrides;
  maxAttempts: number;
  totalTimeoutMs: number;
  rateLimitPerMinute: number;
  streamEnabled: boolean;
}

/** O modelo e os modelos de recurso de quem não tem configuração na base de dados. */
export interface ModelDefaults {
  model: string;
  fallbackModels: string[];
}

/** A configuração de cada ferramenta que o motor lê em cada pedido. Nunca escreve. */
export interface EngineStore {
  settingsFor(
    tool: string,
    defaults: ToolDefaults,
    models: ModelDefaults,
  ): Promise<StoredToolSettings>;
  /** As substituições de todas as ferramentas, numa só leitura (para `GET /v1/tools`). */
  overridesForAll?(): Promise<Map<string, Partial<ToolOverrides>>>;
}

/** O modelo principal nunca é também de recurso, e cada modelo aparece uma só vez. */
export function fallbackChain(model: string, fallbackModels: readonly string[]): string[] {
  return [...new Set(fallbackModels)].filter((m) => m !== model);
}

/** O valor de cada substituição em vigor e de onde vem. */
export function resolveOverrides(
  overrides: Partial<ToolOverrides> | undefined,
  engine: {
    maxAttempts: number;
    totalTimeoutMs: number;
    rateLimitPerMinute: number;
    streamEnabled: boolean;
  },
): {
  [K in keyof ToolOverrides]: { value: NonNullable<ToolOverrides[K]>; source: 'tool' | 'engine' };
} {
  const pick = <K extends keyof ToolOverrides>(key: K) => {
    const own = overrides?.[key];
    return own === null || own === undefined
      ? { value: engine[key] as NonNullable<ToolOverrides[K]>, source: 'engine' as const }
      : { value: own as NonNullable<ToolOverrides[K]>, source: 'tool' as const };
  };
  return {
    maxAttempts: pick('maxAttempts'),
    totalTimeoutMs: pick('totalTimeoutMs'),
    rateLimitPerMinute: pick('rateLimitPerMinute'),
    streamEnabled: pick('streamEnabled'),
  };
}
