import { createHmac, randomUUID } from 'node:crypto';
import type { EngineEvent } from '../engine/engine.js';
import { read, type Live } from '../engine/live.js';
import type { PipelineStage, StageTimings } from '../engine/pipeline.js';

/**
 * Os últimos pedidos de cada ferramenta, **só metadados**, para o dashboard reproduzir um pedido
 * real no diagrama. Ficam em memória, por instância, num buffer de tamanho fixo por ferramenta, e
 * perdem-se ao reiniciar: nada é escrito na base de dados.
 *
 * Nunca guarda o texto do pedido, da resposta nem do prompt, nem o utilizador. A org entra como
 * um id opaco (HMAC com uma chave do servidor): dá para ver que dois pedidos vieram da mesma org,
 * não qual é. Ouve os eventos do motor, como as métricas; o motor não sabe que existe.
 */

export interface TraceStep {
  stage: PipelineStage;
  ms: number;
  /** Só nos passos `models`: uma entrada por chamada (ou salto do disjuntor). */
  model?: string;
  attempt?: number;
  /** Só nos passos `models`: `ok`, `invalid_output`, `provider_unavailable`, `timeout` ou `skipped_breaker`. */
  result?: string;
  /** No passo em que o pedido parou. */
  stopped?: true;
}

export interface Trace {
  /** O id do pedido (o mesmo `X-Request-Id` dos logs). */
  id: string;
  at: string;
  /** Id opaco da org: sempre o mesmo para a mesma org, sem a revelar. */
  orgRef: string;
  durationMs: number;
  outcome: 'success' | 'failed';
  /** O código que o cliente recebeu (só nos que falharam). */
  code?: string;
  /** A razão fina do catálogo `GET /v1/admin/errors`, quando há. */
  reason?: string;
  path: TraceStep[];
}

const TIMED: (keyof StageTimings)[] = ['gate', 'rate', 'access', 'memories', 'prompt'];

export interface TracesOptions {
  enabled: Live<boolean>;
  perTool: Live<number>;
  /** Chave do id opaco. Igual em todas as instâncias para o mesmo id; nunca sai do servidor. */
  orgKey: string;
  now?: () => Date;
}

export class Traces {
  private readonly byTool = new Map<string, Trace[]>();

  constructor(private readonly opts: TracesOptions) {}

  orgRef(orgId: string): string {
    return createHmac('sha256', this.opts.orgKey).update(orgId).digest('hex').slice(0, 16);
  }

  record(event: EngineEvent): void {
    if (event.type === 'model_call' || !read(this.opts.enabled)) return;
    const failed = event.type === 'run_failed';
    const stoppedAt = failed ? event.stage : undefined;
    const path: TraceStep[] = [{ stage: 'request', ms: 0 }];
    const stop = (stage: PipelineStage): boolean => {
      if (stage !== stoppedAt) return false;
      const last = path.at(-1);
      if (last?.stage === stage) last.stopped = true;
      else path.push({ stage, ms: 0, stopped: true });
      return true;
    };

    let done = stop('request');
    for (const stage of TIMED) {
      if (done) break;
      path.push({ stage, ms: event.timings[stage] });
      done = stop(stage);
    }
    if (!done) {
      for (const call of event.calls) {
        path.push({
          stage: 'models',
          ms: call.durationMs,
          model: call.model,
          attempt: call.attempt,
          result: call.reason,
        });
      }
      if (event.calls.length === 0) path.push({ stage: 'models', ms: 0 });
      done = stop('models');
    }
    if (!done) {
      path.push({ stage: 'validate', ms: event.timings.validate });
      done = stop('validate');
    }
    if (!done) {
      path.push({ stage: 'response', ms: 0 });
      stop('response');
    }

    const trace: Trace = {
      id: event.requestId ?? randomUUID(),
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      orgRef: this.orgRef(event.orgId),
      durationMs: event.durationMs,
      outcome: failed ? 'failed' : 'success',
      ...(failed && { code: event.code }),
      ...(failed && event.reason !== undefined && { reason: event.reason }),
      path,
    };
    let list = this.byTool.get(event.tool);
    if (list === undefined) this.byTool.set(event.tool, (list = []));
    list.push(trace);
    const max = read(this.opts.perTool);
    if (list.length > max) list.splice(0, list.length - max);
  }

  /** Os últimos `limit` pedidos da ferramenta, do mais recente para o mais antigo. */
  list(tool: string, limit: number): Trace[] {
    return (this.byTool.get(tool) ?? []).slice(-limit).reverse();
  }
}
