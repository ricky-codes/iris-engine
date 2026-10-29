import { EngineError } from '../engine/errors.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../engine/llm.js';
import type { FetchLike } from './fetch.js';

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number; message?: string };
}

const unavailable = (): EngineError =>
  new EngineError('provider_unavailable', 'O fornecedor de IA não está disponível.');

/**
 * Cliente do OpenRouter (API compatível com OpenAI). Pede a resposta em JSON com o
 * esquema da ferramenta e só usa fornecedores que não guardam nem treinam com os dados.
 */
export class OpenRouterProvider implements LlmProvider {
  constructor(
    private readonly config: { apiKey: string; baseUrl: string },
    private readonly fetchFn: FetchLike = fetch,
    private readonly log: (msg: string, data: Record<string, unknown>) => void = () => undefined,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      // Pede o custo da chamada na resposta (usage.cost).
      usage: { include: true },
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.output.name, strict: true, schema: request.output.schema },
      },
      provider: {
        // Excluir fornecedores que guardam pedidos ou treinam com eles.
        data_collection: 'deny',
        // Só fornecedores que suportam todos os parâmetros, incluindo o formato JSON.
        require_parameters: true,
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'IRIS Engine',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new EngineError('timeout', 'O modelo de IA demorou demasiado a responder.');
      }
      this.log('openrouter unreachable', { err: err instanceof Error ? err.name : String(err) });
      throw unavailable();
    }

    let json: ChatCompletion;
    try {
      json = (await res.json()) as ChatCompletion;
    } catch {
      this.log('openrouter invalid body', { status: res.status });
      throw unavailable();
    }

    if (!res.ok || json.error !== undefined) {
      // Só o código e o estado: a mensagem do fornecedor pode ecoar o pedido.
      this.log('openrouter error', { status: res.status, code: json.error?.code });
      throw unavailable();
    }

    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      this.log('openrouter empty response', { status: res.status });
      throw unavailable();
    }

    return {
      text,
      model: json.model ?? request.model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      costUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : undefined,
    };
  }
}
