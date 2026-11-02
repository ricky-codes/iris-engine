import type { AlertsFacts } from '../alerts/monitor.js';
import type { RuntimeFacts } from './topology.js';

/** O que a página de estado mostra: o serviço, o motor, a configuração, as verificações e os alertas. */
export function statusReport(input: {
  runtime: RuntimeFacts;
  tools: string[];
  defaultModel: string;
  diagnosticTool: boolean;
  alerts: AlertsFacts;
}): Record<string, unknown> {
  const { runtime: rt } = input;
  return {
    service: rt.service,
    engine: { ready: rt.engine.ready, missing: rt.engine.missing, tools: input.tools },
    config: {
      stepAccess: rt.access,
      openRouter: rt.openRouter,
      defaultModel: input.defaultModel,
      diagnosticTool: input.diagnosticTool,
    },
    checks: rt.checks,
    alerts: { configured: input.alerts.configured, active: input.alerts.active },
  };
}
