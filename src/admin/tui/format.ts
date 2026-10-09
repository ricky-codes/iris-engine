/** Ajusta o texto a exatamente `width` caracteres: corta com "…" ou preenche com espaços. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length > width) return width === 1 ? '…' : `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}

export function fmtDate(date: Date | null): string {
  return date === null ? '—' : date.toISOString().slice(0, 10);
}

export function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Com `exactOptionalPropertyTypes`, uma cor ausente não pode passar como `undefined`. */
export function colorProps(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}
