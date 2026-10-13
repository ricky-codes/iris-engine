import type { ToolDefinition } from '../engine/tool.js';
import { diagnosticTool } from './diagnostic.js';

/** As ferramentas que o motor expõe. Acrescentar uma é acrescentá-la aqui. */
export function enabledTools(opts: { diagnostic: boolean }): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (opts.diagnostic) tools.push(diagnosticTool as unknown as ToolDefinition);
  return tools;
}
