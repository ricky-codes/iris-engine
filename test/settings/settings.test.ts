import { describe, expect, it } from 'vitest';
import {
  LiveSettings,
  SETTING_KEYS,
  SettingsError,
  type SettingKey,
  type SettingsStore,
  type StoredSetting,
} from '../../src/settings/settings.js';
import { testSettings } from '../helpers.js';

/** Uma tabela `engine_setting` em memória. */
function memoryStore(initial: StoredSetting[] = []) {
  const rows = new Map(initial.map((r) => [r.key, r]));
  let saves = 0;
  const store: SettingsStore = {
    load: async () => [...rows.values()],
    save: async (changes: { key: SettingKey; value: unknown }[], actor: string) => {
      saves++;
      for (const { key, value } of changes) {
        if (value === null) rows.delete(key);
        else
          rows.set(key, {
            key,
            value,
            updatedAt: new Date('2026-11-06T10:00:00Z'),
            updatedBy: actor,
          });
      }
    },
  };
  return { store, rows, saves: () => saves };
}

const row = (key: string, value: unknown): StoredSetting => ({
  key,
  value,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  updatedBy: 'ana@stepahead.pt',
});

describe('LiveSettings', () => {
  it('sem nada gravado valem os valores iniciais', async () => {
    const settings = testSettings({}, memoryStore().store);
    await settings.refresh();
    expect(settings.current()).toMatchObject({
      defaultModel: 'google/gemini-2.5-flash',
      maxAttempts: 2,
    });
    const views = settings.describe();
    expect(views.map((v) => v.key)).toEqual(SETTING_KEYS);
    expect(views.find((v) => v.key === 'maxAttempts')).toMatchObject({
      source: 'env',
      env: 'LLM_MAX_ATTEMPTS',
      default: 2,
      updatedBy: null,
      constraints: { type: 'integer', minimum: 1, maximum: 5 },
    });
    expect(views.find((v) => v.key === 'memoryPerOrg')).toMatchObject({
      source: 'code',
      env: null,
    });
  });

  it('o que está na base de dados sobrepõe-se; valores inválidos e chaves desconhecidas são ignorados', async () => {
    const warnings: string[] = [];
    const { store } = memoryStore([
      row('maxAttempts', 4),
      row('breakerThreshold', 99),
      row('removida', true),
      row('streamEnabled', false),
    ]);
    const settings = new LiveSettings(testSettings().current(), store, (msg) => warnings.push(msg));
    await settings.refresh();
    expect(settings.current()).toMatchObject({
      maxAttempts: 4,
      breakerThreshold: 3,
      streamEnabled: false,
    });
    expect(warnings).toEqual(['definição inválida na base de dados ignorada']);
    expect(settings.describe().find((v) => v.key === 'maxAttempts')).toMatchObject({
      source: 'database',
      updatedBy: 'ana@stepahead.pt',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('mantém o mesmo objeto enquanto nada muda', async () => {
    const { store, rows } = memoryStore([row('maxAttempts', 4)]);
    const settings = testSettings({}, store);
    await settings.refresh();
    const first = settings.current();
    await settings.refresh();
    expect(settings.current()).toBe(first);
    rows.set('maxAttempts', row('maxAttempts', 5));
    await settings.refresh();
    expect(settings.current()).not.toBe(first);
    expect(settings.current().maxAttempts).toBe(5);
  });

  it('um modelo de recurso gravado que passou a ser o modelo por omissão sai da cadeia', async () => {
    const { store } = memoryStore([row('fallbackModels', ['openai/gpt-4.1-mini', 'x/y'])]);
    const settings = testSettings({ defaultModel: 'x/y' }, store);
    await settings.refresh();
    expect(settings.current().fallbackModels).toEqual(['openai/gpt-4.1-mini']);
  });

  it('grava as alterações válidas e `null` volta ao valor inicial', async () => {
    const { store, rows } = memoryStore();
    const settings = testSettings({}, store);
    await settings.update({ maxAttempts: 3, rateLimitPerMinute: 60 }, 'rui@stepahead.pt');
    expect(settings.current()).toMatchObject({ maxAttempts: 3, rateLimitPerMinute: 60 });
    expect(rows.get('maxAttempts')).toMatchObject({ value: 3, updatedBy: 'rui@stepahead.pt' });

    await settings.update({ maxAttempts: null }, 'rui@stepahead.pt');
    expect(settings.current().maxAttempts).toBe(2);
    expect(rows.has('maxAttempts')).toBe(false);
    expect(settings.describe().find((v) => v.key === 'maxAttempts')?.source).toBe('env');
  });

  it('recusa tudo se uma alteração for inválida, e diz porquê em cada definição', async () => {
    const { store, saves } = memoryStore();
    const settings = testSettings({}, store);
    const err = await settings
      .update(
        { maxAttempts: 9, desconhecida: 1, streamEnabled: 'sim', rateLimitPerMinute: 10 },
        'a',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).issues.map((i) => i.key)).toEqual([
      'maxAttempts',
      'desconhecida',
      'streamEnabled',
    ]);
    expect(saves()).toBe(0);
    expect(settings.current().rateLimitPerMinute).toBe(0);
  });

  it('os modelos de recurso não se repetem nem incluem o modelo por omissão (também o que fica em vigor)', () => {
    const settings = testSettings({}, memoryStore().store);
    expect(settings.validate({ fallbackModels: ['a/b', 'a/b'] })).toEqual([
      { key: 'fallbackModels', issue: 'modelos repetidos' },
    ]);
    expect(settings.validate({ fallbackModels: ['google/gemini-2.5-flash'] })).toEqual([
      { key: 'fallbackModels', issue: 'não pode incluir o modelo por omissão' },
    ]);
    expect(
      settings.validate({ defaultModel: 'a/b', fallbackModels: ['google/gemini-2.5-flash'] }),
    ).toEqual([]);
    expect(settings.validate({ fallbackModels: ['a', 'b', 'c', 'd'] })).toHaveLength(1);
    expect(settings.validate({ defaultModel: 'com espaço' })).toHaveLength(1);
  });

  it('sem base de dados não grava', async () => {
    await expect(testSettings().update({ maxAttempts: 3 }, 'a')).rejects.toThrow(/base de dados/);
  });
});
