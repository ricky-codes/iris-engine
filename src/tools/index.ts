import type { ToolDefinition } from '../engine/tool.js';
import { diagnosticTool } from './diagnostic.js';
import { replyTool } from './reply.js';
import { sentimentTool } from './sentiment.js';
import { tipificationTool } from './tipification.js';

/** As ferramentas que o motor expõe. Acrescentar uma é acrescentá-la aqui. */
export function enabledTools(opts: { diagnostic: boolean }): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    sentimentTool as unknown as ToolDefinition,
    replyTool as unknown as ToolDefinition,
    tipificationTool as unknown as ToolDefinition,
  ];
  if (opts.diagnostic) tools.push(diagnosticTool as unknown as ToolDefinition);
  return tools;
}
