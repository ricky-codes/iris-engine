import type { Pool } from 'pg';
import type { Metrics } from '../engine/metrics.js';
import { fallbackChain } from '../engine/store.js';
import { memoryLimitsOf, type RuntimeSettings } from '../settings/settings.js';
import type { ToolDefinition } from '../engine/tool.js';
import { memoriesIn } from './commands.js';
import { listToolCatalog, type ToolCatalogRow } from './tools.js';
import {
  buildTopology,
  type BreakerFact,
  type RuntimeFacts,
  type ToolFact,
  type Topology,
} from './topology.js';

export interface TopologySourceDeps {
  /** Sem base de dados não há catálogo nem memórias: entram só as ferramentas do código. */
  pool: Pool | undefined;
  runtime: () => Promise<RuntimeFacts>;
  /** As ferramentas implementadas neste servidor. */
  tools: ToolDefinition[];
  /** As definições em vigor (modelos por omissão e limites das memórias). */
  settings: () => RuntimeSettings;
  metrics: Metrics;
  breakers: () => BreakerFact[];
}

/**
 * Junta o que está a correr numa topologia para a rota `/v1/admin/topology`, com as mesmas
 * verificações do `/status` (sem chamadas extra aos serviços externos).
 */
export async function collectTopology(d: TopologySourceDeps): Promise<Topology> {
  const registered = new Map(d.tools.map((t) => [t.name, t]));
  const settings = d.settings();
  const memories = d.pool === undefined ? undefined : memoriesIn(d.pool);
  const [runtime, catalog, org, user] = await Promise.all([
    d.runtime(),
    d.pool === undefined
      ? Promise.resolve<ToolCatalogRow[]>(
          d.tools.map((t) => ({
            name: t.name,
            config: null,
            activePromptVersion: null,
            promptVersionCount: 0,
          })),
        )
      : listToolCatalog(d.pool),
    memories?.count({ scope: 'org' }) ?? 0,
    memories?.count({ scope: 'user' }) ?? 0,
  ]);
  const usage = new Map(d.metrics.snapshot().byTool.map((t) => [t.tool, t]));
  const tools: ToolFact[] = catalog.map((row) => {
    const code = registered.get(row.name);
    const config = row.config ?? (code === undefined ? null : undefined);
    const model = config === null ? null : (config?.model ?? settings.defaultModel);
    return {
      name: row.name,
      implemented: code !== undefined,
      version: code?.version ?? null,
      enabled: row.config?.enabled ?? true,
      model,
      modelSource: config === null ? null : config === undefined ? 'default' : 'database',
      fallbackModels:
        model === null
          ? []
          : (config?.fallbackModels ?? fallbackChain(model, settings.fallbackModels)),
      prompt: {
        source:
          row.activePromptVersion !== null ? 'database' : code !== undefined ? 'code' : 'none',
        version: row.activePromptVersion,
      },
      requests: usage.get(row.name)?.requests ?? 0,
      failed: usage.get(row.name)?.failed ?? 0,
      fallbacks: usage.get(row.name)?.fallbacks ?? 0,
    };
  });
  return buildTopology({
    runtime,
    tools,
    breakers: d.breakers(),
    memories: {
      org,
      user,
      limits: memoryLimitsOf(settings),
    },
  });
}
