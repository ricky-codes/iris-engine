import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MEMORY_CHARS_CAP, type MemoryLimits } from '../engine/memory.js';
import type { PipelineStage } from '../engine/pipeline.js';
import { fallbackChain, OVERRIDE_KEYS, type ToolOverrides } from '../engine/store.js';

/**
 * As definições que se mudam sem reiniciar. Cada uma nasce no `.env` (ou numa constante do
 * código) e pode ser substituída na base de dados (`engine_setting`) pela API de administração.
 * O serviço lê-as de memória: carregam-se no arranque e voltam a ler-se a cada
 * `SETTINGS_REFRESH_MS`, por isso as outras instâncias apanham uma alteração nesse intervalo.
 */
export interface RuntimeSettings {
  defaultModel: string;
  fallbackModels: string[];
  totalTimeoutMs: number;
  maxAttempts: number;
  breakerThreshold: number;
  breakerOpenMs: number;
  streamEnabled: boolean;
  rateLimitPerMinute: number;
  stepAccessTimeoutMs: number;
  stepAccessUsageTimeoutMs: number;
  memoryMaxChars: number;
  memoryPerOrg: number;
  memoryPerUser: number;
  tracesEnabled: boolean;
  tracesPerTool: number;
}

export type SettingKey = keyof RuntimeSettings;
export type SettingGroup = 'models' | 'requests' | 'stepAccess' | 'memories' | 'traces';

export const SETTINGS_REFRESH_MS = 30_000;

/** Os limites de cada definição. O `config.ts` usa os mesmos para as variáveis de ambiente. */
export const RANGES = {
  totalTimeoutMs: { minimum: 2000, maximum: 115_000 },
  maxAttempts: { minimum: 1, maximum: 5 },
  breakerThreshold: { minimum: 1, maximum: 20 },
  breakerOpenMs: { minimum: 1000, maximum: 3_600_000 },
  rateLimitPerMinute: { minimum: 0, maximum: 100_000 },
  stepAccessTimeoutMs: { minimum: 100, maximum: 30_000 },
  stepAccessUsageTimeoutMs: { minimum: 100, maximum: 60_000 },
  memoryMaxChars: { minimum: 50, maximum: MEMORY_CHARS_CAP },
  memoryPerOrg: { minimum: 1, maximum: 200 },
  memoryPerUser: { minimum: 1, maximum: 100 },
  tracesPerTool: { minimum: 10, maximum: 500 },
} as const;

const ModelCode = Type.String({ minLength: 1, maxLength: 200, pattern: '^\\S+$' });
const int = (key: keyof typeof RANGES) => Type.Integer(RANGES[key]);

interface Definition {
  group: SettingGroup;
  label: string;
  description: string;
  schema: TSchema;
  /** A variável de ambiente que dá o valor inicial; `null` quando é uma constante do código. */
  env: string | null;
  /** O passo do pedido que esta definição governa (`GET /v1/admin/tools/:name/pipeline`). */
  stage: PipelineStage;
}

export const DEFINITIONS: Record<SettingKey, Definition> = {
  defaultModel: {
    group: 'models',
    label: 'Modelo por omissão',
    description: 'Para as ferramentas sem modelo configurado. Tem de existir no OpenRouter.',
    schema: ModelCode,
    env: 'LLM_DEFAULT_MODEL',
    stage: 'models',
  },
  fallbackModels: {
    group: 'models',
    label: 'Modelos de recurso por omissão',
    description: 'Até 3, por ordem, sem repetidos e sem o modelo por omissão.',
    schema: Type.Array(ModelCode, { maxItems: 3 }),
    env: 'LLM_FALLBACK_MODELS',
    stage: 'models',
  },
  totalTimeoutMs: {
    group: 'models',
    label: 'Teto de tempo de um pedido',
    description: 'Soma de todas as chamadas ao modelo, abaixo do limite de callout do Apex.',
    schema: int('totalTimeoutMs'),
    env: 'LLM_TOTAL_TIMEOUT_MS',
    stage: 'models',
  },
  maxAttempts: {
    group: 'models',
    label: 'Tentativas por modelo',
    description: 'Quantas vezes se pede uma resposta válida a cada modelo antes do seguinte.',
    schema: int('maxAttempts'),
    env: 'LLM_MAX_ATTEMPTS',
    stage: 'validate',
  },
  breakerThreshold: {
    group: 'models',
    label: 'Falhas para abrir o disjuntor',
    description: 'Falhas seguidas do fornecedor para o modelo passar a ser saltado.',
    schema: int('breakerThreshold'),
    env: 'LLM_BREAKER_THRESHOLD',
    stage: 'models',
  },
  breakerOpenMs: {
    group: 'models',
    label: 'Tempo com o disjuntor aberto',
    description: 'Durante quanto tempo o modelo é saltado.',
    schema: int('breakerOpenMs'),
    env: 'LLM_BREAKER_OPEN_MS',
    stage: 'models',
  },
  streamEnabled: {
    group: 'requests',
    label: 'Streaming ligado',
    description: 'Desligado, `"stream": true` é recusado em todas as ferramentas.',
    schema: Type.Boolean(),
    env: 'STREAM_ENABLED',
    stage: 'response',
  },
  rateLimitPerMinute: {
    group: 'requests',
    label: 'Pedidos por minuto e por org',
    description: 'Por instância, nas rotas das ferramentas. 0 = sem limite.',
    schema: int('rateLimitPerMinute'),
    env: 'RATE_LIMIT_PER_MINUTE',
    stage: 'rate',
  },
  stepAccessTimeoutMs: {
    group: 'stepAccess',
    label: 'Tempo máximo da verificação de acesso',
    description: 'Passado este tempo, o StepAccess conta como indisponível (503).',
    schema: int('stepAccessTimeoutMs'),
    env: 'STEPACCESS_TIMEOUT_MS',
    stage: 'access',
  },
  stepAccessUsageTimeoutMs: {
    group: 'stepAccess',
    label: 'Tempo máximo do envio do custo',
    description: 'Em segundo plano, por isso mais folgado que o da verificação.',
    schema: int('stepAccessUsageTimeoutMs'),
    env: 'STEPACCESS_USAGE_TIMEOUT_MS',
    stage: 'response',
  },
  memoryMaxChars: {
    group: 'memories',
    label: 'Caracteres por memória',
    description: 'Vale para as memórias novas e para as que se editam; as que já existem ficam.',
    schema: int('memoryMaxChars'),
    env: null,
    stage: 'memories',
  },
  memoryPerOrg: {
    group: 'memories',
    label: 'Memórias por org',
    description: 'Baixar o limite não apaga nada: só impede criar mais.',
    schema: int('memoryPerOrg'),
    env: null,
    stage: 'memories',
  },
  memoryPerUser: {
    group: 'memories',
    label: 'Memórias por utilizador',
    description: 'Baixar o limite não apaga nada: só impede criar mais.',
    schema: int('memoryPerUser'),
    env: null,
    stage: 'memories',
  },
  tracesEnabled: {
    group: 'traces',
    label: 'Guardar os últimos pedidos',
    description:
      'Só metadados, em memória e por instância: passos, tempos, modelos e um id opaco da org. Nunca texto.',
    schema: Type.Boolean(),
    env: null,
    stage: 'response',
  },
  tracesPerTool: {
    group: 'traces',
    label: 'Pedidos guardados por ferramenta',
    description: 'Os mais antigos saem quando se chega ao limite.',
    schema: int('tracesPerTool'),
    env: null,
    stage: 'response',
  },
};

export const SETTING_KEYS = Object.keys(DEFINITIONS) as SettingKey[];

const isKey = (key: string): key is SettingKey => Object.hasOwn(DEFINITIONS, key);

/** Uma definição gravada na base de dados. */
export interface StoredSetting {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: string;
}

/** Onde as definições ficam gravadas. `null` apaga a linha (volta ao valor inicial). */
export interface SettingsStore {
  load(): Promise<StoredSetting[]>;
  save(changes: { key: SettingKey; value: unknown }[], actor: string): Promise<void>;
}

/** O que a API de administração mostra de cada definição. */
export interface SettingView {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  description: string;
  value: unknown;
  /** O valor sem nada na base de dados (do `.env` ou do código). */
  default: unknown;
  /** De onde vem o valor em vigor. */
  source: 'database' | 'env' | 'code';
  env: string | null;
  /** O passo do pedido que governa. */
  stage: PipelineStage;
  /** `true`: cada ferramenta pode ter um valor próprio (`PUT /v1/admin/tools/:name/config`). */
  overridablePerTool: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  constraints: Record<string, unknown>;
}

export interface SettingIssue {
  key: string;
  issue: string;
}

export class SettingsError extends Error {
  constructor(public readonly issues: SettingIssue[]) {
    super('As definições não são válidas.');
    this.name = 'SettingsError';
  }
}

function constraintsOf(schema: TSchema): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  const items = s['items'] as Record<string, unknown> | undefined;
  return Object.fromEntries(
    Object.entries({
      type: s['type'],
      minimum: s['minimum'],
      maximum: s['maximum'],
      maxItems: s['maxItems'],
      maxLength: s['maxLength'] ?? items?.['maxLength'],
    }).filter(([, v]) => v !== undefined),
  );
}

/** As regras que envolvem mais de uma definição. */
function crossIssues(s: RuntimeSettings): SettingIssue[] {
  const issues: SettingIssue[] = [];
  if (new Set(s.fallbackModels).size !== s.fallbackModels.length)
    issues.push({ key: 'fallbackModels', issue: 'modelos repetidos' });
  if (s.fallbackModels.includes(s.defaultModel))
    issues.push({ key: 'fallbackModels', issue: 'não pode incluir o modelo por omissão' });
  return issues;
}

/**
 * As definições em vigor, em memória. `current()` é síncrono e devolve o mesmo objeto enquanto
 * nada muda, para quem o usa poder comparar por identidade.
 */
export class LiveSettings {
  private stored = new Map<SettingKey, StoredSetting>();
  private snapshot: RuntimeSettings;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly defaults: RuntimeSettings,
    private readonly store?: SettingsStore,
    private readonly log: (msg: string, data: Record<string, unknown>) => void = () => undefined,
  ) {
    this.snapshot = defaults;
  }

  current(): RuntimeSettings {
    return this.snapshot;
  }

  /** Volta a ler a base de dados. Valores inválidos (escritos à mão) são ignorados. */
  async refresh(): Promise<void> {
    if (this.store === undefined) return;
    const rows = await this.store.load();
    const stored = new Map<SettingKey, StoredSetting>();
    for (const row of rows) {
      if (!isKey(row.key)) continue;
      if (!Value.Check(DEFINITIONS[row.key].schema, row.value)) {
        this.log('definição inválida na base de dados ignorada', { key: row.key });
        continue;
      }
      stored.set(row.key, row);
    }
    this.stored = stored;
    const merged = { ...this.defaults } as Record<SettingKey, unknown>;
    for (const [key, row] of stored) merged[key] = row.value;
    const next = merged as unknown as RuntimeSettings;
    // O modelo por omissão do `.env` pode ter mudado para um dos de recurso gravados.
    next.fallbackModels = fallbackChain(next.defaultModel, next.fallbackModels);
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) this.snapshot = next;
  }

  /** Lê a base de dados a cada `intervalMs`, até `stop()`. */
  start(intervalMs = SETTINGS_REFRESH_MS): void {
    if (this.store === undefined || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.refresh().catch((err: unknown) => {
        this.log('não foi possível ler as definições', { err: String(err) });
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Os problemas de um conjunto de alterações, sem gravar nada. Vazio = válido. */
  validate(changes: Record<string, unknown>): SettingIssue[] {
    const issues: SettingIssue[] = [];
    const merged = { ...this.snapshot } as Record<SettingKey, unknown>;
    for (const [key, value] of Object.entries(changes)) {
      if (!isKey(key)) {
        issues.push({ key, issue: 'definição desconhecida' });
        continue;
      }
      const { schema } = DEFINITIONS[key];
      if (value !== null && !Value.Check(schema, value)) {
        const first = [...Value.Errors(schema, value)][0];
        issues.push({ key, issue: first?.message ?? 'valor inválido' });
        continue;
      }
      merged[key] = value ?? this.defaults[key];
    }
    return issues.length > 0 ? issues : crossIssues(merged as unknown as RuntimeSettings);
  }

  /**
   * Valida e grava. `null` volta ao valor inicial. Tudo ou nada: com um problema, nada é gravado.
   * Lança `SettingsError` com os problemas de cada definição.
   */
  async update(changes: Record<string, unknown>, actor: string): Promise<void> {
    if (this.store === undefined) throw new Error('Sem base de dados não há definições a gravar.');
    const issues = this.validate(changes);
    if (issues.length > 0) throw new SettingsError(issues);
    const valid = Object.entries(changes).map(([key, value]) => ({
      key: key as SettingKey,
      value,
    }));
    if (valid.length === 0) return;
    await this.store.save(valid, actor);
    await this.refresh();
  }

  describe(): SettingView[] {
    return SETTING_KEYS.map((key) => {
      const def = DEFINITIONS[key];
      const row = this.stored.get(key);
      return {
        key,
        group: def.group,
        label: def.label,
        description: def.description,
        value: this.snapshot[key],
        default: this.defaults[key],
        source: row !== undefined ? 'database' : def.env === null ? 'code' : 'env',
        env: def.env,
        stage: def.stage,
        overridablePerTool: (OVERRIDE_KEYS as readonly string[]).includes(key),
        updatedAt: row?.updatedAt.toISOString() ?? null,
        updatedBy: row?.updatedBy ?? null,
        constraints: constraintsOf(def.schema),
      };
    });
  }
}

/** Os limites das memórias em vigor. */
export const memoryLimitsOf = (s: RuntimeSettings): MemoryLimits => ({
  chars: s.memoryMaxChars,
  perOrg: s.memoryPerOrg,
  perUser: s.memoryPerUser,
});

/**
 * Valida as substituições de uma ferramenta com as mesmas regras (e mensagens) de
 * `PATCH /v1/admin/settings`. `null` ou ausente: segue a definição global.
 */
export function overrideIssues(
  values: Partial<Record<keyof ToolOverrides, unknown>>,
): SettingIssue[] {
  return OVERRIDE_KEYS.flatMap((key) => {
    const value = values[key];
    if (value === null || value === undefined) return [];
    const { schema } = DEFINITIONS[key];
    if (Value.Check(schema, value)) return [];
    const first = [...Value.Errors(schema, value)][0];
    return [{ key, issue: first?.message ?? 'valor inválido' }];
  });
}
