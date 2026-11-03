import { describe, expect, it } from 'vitest';
import { StringFieldStream } from '../../src/engine/stream.js';

/** Alimenta o extrator com o texto partido em pedaços de `size` caracteres. */
function extract(json: string, field: string, size: number): string {
  const s = new StringFieldStream(field);
  let out = '';
  for (let i = 0; i < json.length; i += size) out += s.feed(json.slice(i, i + size));
  return out;
}

describe('StringFieldStream', () => {
  const sizes = [1, 2, 3, 7, 1000];

  it.each(sizes)('extrai o campo, com pedaços de %i caracteres', (size) => {
    expect(extract('{"reply":"Olá, tudo bem?"}', 'reply', size)).toBe('Olá, tudo bem?');
  });

  it.each(sizes)('descodifica escapes e pares substitutos, com pedaços de %i', (size) => {
    const json = JSON.stringify({ reply: 'linha 1\nlinha "2"\t\\ / 😀 ç' });
    expect(extract(json, 'reply', size)).toBe('linha 1\nlinha "2"\t\\ / 😀 ç');
    expect(extract('{"reply":"\\ud83d\\ude00!"}', 'reply', size)).toBe('😀!');
  });

  it('salta campos anteriores, incluindo objetos, listas e textos com aspas e chaves', () => {
    const json = JSON.stringify({
      other: { reply: 'não este', x: ['a"b', '}{'] },
      list: [{ reply: 'nem este' }],
      n: 3,
      flag: true,
      nothing: null,
      reply: 'este',
      after: 'depois',
    });
    for (const size of sizes) expect(extract(json, 'reply', size)).toBe('este');
  });

  it('ignora o bloco ```json que alguns modelos abrem', () => {
    expect(extract('```json\n{ "reply" : "ok" }\n```', 'reply', 2)).toBe('ok');
  });

  it('dá nada quando o campo não existe ou não é texto', () => {
    expect(extract('{"other":"x"}', 'reply', 3)).toBe('');
    expect(extract('{"reply":12}', 'reply', 3)).toBe('');
  });

  it('termina no fim do campo e ignora o resto', () => {
    const s = new StringFieldStream('reply');
    expect(s.feed('{"reply":"a')).toBe('a');
    expect(s.finished).toBe(false);
    expect(s.feed('b","x":"y"}')).toBe('b');
    expect(s.finished).toBe(true);
    expect(s.feed('{"reply":"outra"}')).toBe('');
  });

  it('um par substituto incompleto não sai como lixo', () => {
    expect(extract('{"reply":"\\ud83dx"}', 'reply', 1)).toBe('�x');
  });
});
