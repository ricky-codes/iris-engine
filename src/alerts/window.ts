import type { MetricsSnapshot } from '../engine/metrics.js';

/** O que aconteceu a uma ferramenta dentro da janela. Só contagens e códigos de erro. */
export interface ToolWindow {
  tool: string;
  requests: number;
  failed: number;
  errorsByCode: Record<string, number>;
  fallbacks: number;
}

interface Point {
  at: number;
  byTool: Map<string, Omit<ToolWindow, 'tool'>>;
}

const pointOf = (at: number, snapshot: MetricsSnapshot): Point => ({
  at,
  byTool: new Map(
    snapshot.byTool.map((t) => [
      t.tool,
      {
        requests: t.requests,
        failed: t.failed,
        errorsByCode: { ...t.errorsByCode },
        fallbacks: t.fallbacks,
      },
    ]),
  ),
});

/**
 * As métricas são cumulativas desde o arranque. Para saber o que aconteceu nos últimos
 * `windowMs`, guarda fotografias num anel em memória e subtrai a mais recente que já tem
 * pelo menos `windowMs` (ou a primeira, logo depois do arranque). Não muda as métricas.
 */
export class MetricsWindow {
  private readonly points: Point[] = [];

  constructor(private readonly windowMs: number) {}

  push(at: number, snapshot: MetricsSnapshot): void {
    this.points.push(pointOf(at, snapshot));
    // Fica só uma fotografia anterior ao início da janela: as mais antigas já não servem.
    while (this.points.length >= 2 && (this.points[1]?.at ?? Infinity) <= at - this.windowMs) {
      this.points.shift();
    }
  }

  /** Diferença entre a última fotografia e a base da janela, por ferramenta. */
  delta(): ToolWindow[] {
    const base = this.points[0];
    const last = this.points[this.points.length - 1];
    if (base === undefined || last === undefined) return [];
    return [...last.byTool]
      .map(([tool, now]) => {
        const before = base.byTool.get(tool);
        const errorsByCode: Record<string, number> = {};
        for (const [code, n] of Object.entries(now.errorsByCode)) {
          const d = n - (before?.errorsByCode[code] ?? 0);
          if (d > 0) errorsByCode[code] = d;
        }
        return {
          tool,
          requests: now.requests - (before?.requests ?? 0),
          failed: now.failed - (before?.failed ?? 0),
          errorsByCode,
          fallbacks: now.fallbacks - (before?.fallbacks ?? 0),
        };
      })
      .sort((a, b) => a.tool.localeCompare(b.tool));
  }

  /** Quanto tempo a janela cobre de facto (menos que `windowMs` logo depois do arranque). */
  coveredMs(): number {
    const base = this.points[0];
    const last = this.points[this.points.length - 1];
    return base === undefined || last === undefined ? 0 : last.at - base.at;
  }
}
