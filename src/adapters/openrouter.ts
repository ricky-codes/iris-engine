import { EngineError } from '../engine/errors.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../engine/llm.js';
import type { FetchLike } from './fetch.js';

/** Um pedaço de uma resposta em streaming (`stream: true`). */
interface ChatChunk extends ChatCompletion {
  choices?: { message?: { content?: string | null }; delta?: { content?: string | null } }[];
}

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
      ...(request.onText !== undefined && { stream: true }),
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

    if (request.onText !== undefined && res.ok && res.body !== null) {
      return this.readStream(res, request, request.onText);
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

  /**
   * Lê a resposta em streaming (SSE): cada `data:` é um pedaço do JSON, entregue a `onText`;
   * o último traz o modelo e o uso. As linhas de comentário (`: …`) são só para manter a
   * ligação viva.
   */
  private async readStream(
    res: Response,
    request: LlmRequest,
    onText: (chunk: string) => void,
  ): Promise<LlmResponse> {
    let text = '';
    let model: string | undefined;
    let usage: ChatCompletion['usage'];
    const state = { failed: false };

    const handle = (payload: string): void => {
      if (payload === '[DONE]') return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        state.failed = true;
        return;
      }
      if (chunk.error !== undefined) {
        // Só o código: a mensagem do fornecedor pode ecoar o pedido.
        this.log('openrouter stream error', { code: chunk.error.code });
        state.failed = true;
        return;
      }
      model = chunk.model ?? model;
      usage = chunk.usage ?? usage;
      const piece = chunk.choices?.[0]?.delta?.content;
      if (typeof piece === 'string' && piece !== '') {
        text += piece;
        onText(piece);
      }
    };

    try {
      const decoder = new TextDecoder();
      let pending = '';
      // `res.body` existe: quem chama já verificou.
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(part, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
      pending += decoder.decode();
      if (pending.startsWith('data:')) handle(pending.slice(5).trim());
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new EngineError('timeout', 'O modelo de IA demorou demasiado a responder.');
      }
      this.log('openrouter stream interrupted', {
        err: err instanceof Error ? err.name : String(err),
      });
      throw unavailable();
    }

    if (state.failed || text === '') {
      this.log('openrouter empty response', { stream: true });
      throw unavailable();
    }
    return {
      text,
      model: model ?? request.model,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      costUsd: typeof usage?.cost === 'number' ? usage.cost : undefined,
    };
  }
}
