import { Text } from 'ink';
import { colorProps, fit } from './format.js';

export interface Column<T> {
  header: string;
  /** Sem largura, a coluna ocupa o espaço que sobra. */
  width?: number;
  render: (row: T) => string;
  color?: (row: T) => string | undefined;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selected: number;
  /** Linhas disponíveis, incluindo o cabeçalho. */
  height: number;
  width: number;
  showHeader?: boolean;
  empty: string;
  rowKey: (row: T, index: number) => string;
}

const GAP = 2;

/** Tabela com seleção e deslocamento vertical. Cada linha ocupa exatamente uma linha do terminal. */
export function Table<T>({
  columns,
  rows,
  selected,
  height,
  width,
  showHeader = true,
  empty,
  rowKey,
}: TableProps<T>) {
  const fixed = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const flexCount = columns.filter((c) => c.width === undefined).length;
  const gaps = GAP * (columns.length - 1);
  const flexWidth =
    flexCount === 0 ? 0 : Math.max(8, Math.floor((width - fixed - gaps) / flexCount));
  const widths = columns.map((c) => c.width ?? flexWidth);

  const visible = Math.max(1, height - (showHeader ? 1 : 0));
  const start = Math.min(
    Math.max(0, selected - Math.floor(visible / 2)),
    Math.max(0, rows.length - visible),
  );
  const slice = rows.slice(start, start + visible);

  return (
    <>
      {showHeader && (
        <Text bold dimColor>
          {columns
            .map(
              (c, i) =>
                fit(c.header, widths[i] ?? 0) + (i < columns.length - 1 ? ' '.repeat(GAP) : ''),
            )
            .join('')}
        </Text>
      )}
      {rows.length === 0 && <Text dimColor>{empty}</Text>}
      {slice.map((row, offset) => {
        const index = start + offset;
        const isSelected = index === selected;
        return (
          <Text key={rowKey(row, index)}>
            {columns.map((c, i) => (
              <Text key={i} inverse={isSelected} {...colorProps(c.color?.(row))}>
                {fit(c.render(row), widths[i] ?? 0) +
                  (i < columns.length - 1 ? ' '.repeat(GAP) : '')}
              </Text>
            ))}
          </Text>
        );
      })}
    </>
  );
}
