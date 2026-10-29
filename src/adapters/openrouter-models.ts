import { EngineError } from '../engine/errors.js';
import type { FetchLike } from './fetch.js';

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** Preço por milhão de tokens (USD), quando o OpenRouter o indica. */
  promptPricePerMillion: number | null;
  completionPricePerMillion: number | null;
  /** O modelo aceita respostas com JSON Schema (necessário para as ferramentas). */
  supportsStructuredOutput: boolean;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
}

const CACHE_MS = 15 * 60 * 1000;

const perMillion = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1000) / 1000 : null;
};

/** Catálogo de modelos do OpenRouter, com cache de 15 minutos. */
export class ModelCatalog {
  private cache: { at: number; models: ModelInfo[] } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(): Promise<{ models: ModelInfo[]; fetchedAt: string }> {
    if (this.cache === undefined || this.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: this.now(), models: await this.fetchModels() };
    }
    return { models: this.cache.models, fetchedAt: new Date(this.cache.at).toISOString() };
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    let body: { data?: RawModel[] };
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      body = (await res.json()) as { data?: RawModel[] };
    } catch {
      throw new EngineError(
        'provider_unavailable',
        'Não foi possível obter a lista de modelos do OpenRouter.',
      );
    }
    return (body.data ?? [])
      .filter((m): m is RawModel & { id: string } => typeof m.id === 'string')
      .map((m) => {
        const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
        return {
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          contextLength: typeof m.context_length === 'number' ? m.context_length : null,
          promptPricePerMillion: perMillion(m.pricing?.prompt),
          completionPricePerMillion: perMillion(m.pricing?.completion),
          supportsStructuredOutput:
            params.includes('structured_outputs') || params.includes('response_format'),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
