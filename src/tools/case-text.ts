/**
 * Prepara os dados de um Case (que vêm do Salesforce com campos livres) para irem ao modelo:
 * tira contactos e moradas de email, mascara emails escritos no texto e limita os tamanhos.
 * O modelo só precisa do conteúdo e do sentido (recebido ou enviado), não de quem é quem.
 */

const MAX_STRING = 6000;
const MAX_SECTION = 40_000;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PRIVATE_KEY = /e-?mail|address|phone|mobile|telefone|telemovel/i;

export type Obj = Record<string, unknown>;

function clean(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const masked = value.replace(EMAIL_IN_TEXT, '[email]');
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
  }
  if (Array.isArray(value)) return depth > 3 ? undefined : value.map((v) => clean(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (depth > 3) return undefined;
    const out: Obj = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'attributes' || PRIVATE_KEY.test(key)) continue;
      const cleaned = clean(v, depth + 1);
      if (cleaned === null || cleaned === undefined || cleaned === '') continue;
      out[key] = cleaned;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

/** Um objeto como JSON compacto e limpo. Vazio devolve `(sem dados)`. */
export function renderObject(value: Obj | null | undefined): string {
  if (value === null || value === undefined) return '(sem dados)';
  const cleaned = clean(value);
  return cleaned === undefined ? '(sem dados)' : JSON.stringify(cleaned);
}

/** Uma lista de itens, um por linha, cada um com a etiqueta devolvida por `label`. */
export function renderList(
  items: Obj[] | null | undefined,
  label: (item: Obj) => { tag: string; omit: string[] },
): string {
  if (items === null || items === undefined || items.length === 0) return '(nenhum)';
  const lines: string[] = [];
  let size = 0;
  for (const item of items) {
    const { tag, omit } = label(item);
    const rest = Object.fromEntries(Object.entries(item).filter(([k]) => !omit.includes(k)));
    const line = `- [${tag}] ${renderObject(rest)}`;
    size += line.length;
    if (size > MAX_SECTION) {
      lines.push('- (restantes omitidos por tamanho)');
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
