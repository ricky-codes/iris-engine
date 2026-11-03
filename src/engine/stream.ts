/**
 * Streaming de uma ferramenta: o modelo devolve JSON, mas só um campo de texto (`tool.stream.field`)
 * é enviado ao cliente à medida que nasce. O resto do JSON só chega, validado, no fim.
 */

/** Quem recebe o texto à medida que o modelo o escreve. */
export interface StreamHandlers {
  /** Uma só vez, quando o pedido passou configuração e acesso e vai começar a chamada ao modelo. */
  onStart?: () => void;
  /** Mais um pedaço do campo de texto, já descodificado. */
  onDelta: (text: string) => void;
  /**
   * Deitar fora o texto recebido até agora: vem aí uma nova tentativa (resposta inválida ou
   * modelo de recurso). Só é chamado se já tinha sido enviado texto.
   */
  onReset: () => void;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Extrai, de um JSON que chega aos bocados, o valor de um campo de texto do objeto de topo.
 * Ignora o que vem antes do primeiro `{` (alguns modelos abrem um bloco ```json) e os outros
 * campos, incluindo objetos e listas. Cada `feed` devolve só o texto novo.
 */
export class StringFieldStream {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private expectingKey = false;
  private keyCandidate = false;
  private key = '';
  private currentKey: string | null = null;
  private afterColon = false;
  private capturing = false;
  private done = false;
  /** `\uXXXX` em curso: dígitos já lidos (`null` fora de um). */
  private unicode: string | null = null;
  private highSurrogate: string | null = null;

  constructor(private readonly field: string) {}

  /** O campo já terminou (fechou as aspas). */
  get finished(): boolean {
    return this.done;
  }

  feed(chunk: string): string {
    let out = '';
    for (const c of chunk) {
      if (this.done) break;
      out += this.capturing ? this.captureChar(c) : this.scanChar(c);
    }
    return out;
  }

  private captureChar(c: string): string {
    if (this.unicode !== null) {
      this.unicode += c;
      if (this.unicode.length < 4) return '';
      const unit = String.fromCharCode(Number.parseInt(this.unicode, 16) || 0xfffd);
      this.unicode = null;
      return this.pushUnit(unit);
    }
    if (this.escaped) {
      this.escaped = false;
      if (c === 'u') {
        this.unicode = '';
        return '';
      }
      return this.flushHigh() + (SIMPLE_ESCAPES[c] ?? c);
    }
    if (c === '\\') {
      this.escaped = true;
      return '';
    }
    if (c === '"') {
      this.capturing = false;
      this.done = true;
      return this.flushHigh();
    }
    return this.flushHigh() + c;
  }

  /** Uma metade alta de um par substituto espera pela baixa para sair inteira. */
  private pushUnit(unit: string): string {
    const code = unit.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff) {
      const previous = this.flushHigh();
      this.highSurrogate = unit;
      return previous;
    }
    if (code >= 0xdc00 && code <= 0xdfff && this.highSurrogate !== null) {
      const pair = this.highSurrogate + unit;
      this.highSurrogate = null;
      return pair;
    }
    return this.flushHigh() + unit;
  }

  private flushHigh(): string {
    if (this.highSurrogate === null) return '';
    this.highSurrogate = null;
    return '�';
  }

  private scanChar(c: string): string {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        if (this.keyCandidate) this.key += c;
      } else if (c === '\\') {
        this.escaped = true;
      } else if (c === '"') {
        this.inString = false;
        if (this.keyCandidate) {
          this.currentKey = this.key;
          this.keyCandidate = false;
        }
      } else if (this.keyCandidate) {
        this.key += c;
      }
      return '';
    }
    switch (c) {
      case '{':
      case '[':
        this.depth++;
        this.afterColon = false;
        if (this.depth === 1 && c === '{') this.expectingKey = true;
        return '';
      case '}':
      case ']':
        this.depth--;
        this.afterColon = false;
        return '';
      case ',':
        if (this.depth === 1) this.expectingKey = true;
        return '';
      case ':':
        if (this.depth === 1 && this.currentKey !== null) {
          this.afterColon = true;
          this.expectingKey = false;
        }
        return '';
      case '"':
        if (this.depth === 1 && this.afterColon && this.currentKey === this.field) {
          this.afterColon = false;
          this.capturing = true;
          return '';
        }
        this.afterColon = false;
        this.inString = true;
        this.keyCandidate = this.depth === 1 && this.expectingKey;
        this.key = '';
        return '';
      default:
        if (!/\s/.test(c)) this.afterColon = false;
        return '';
    }
  }
}
