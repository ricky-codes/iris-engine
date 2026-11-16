/**
 * O tratamento da ferramenta `reply`, em código, para o modelo receber só o que serve para
 * escrever a resposta e o cliente receber um texto limpo:
 *
 * - entrada: monta uma mensagem por secções, pela ordem de importância, em vez do JSON inteiro;
 *   limpa os emails (histórico citado, referências de thread, assinaturas), tira o email
 *   selecionado da conversa, junta respostas repetidas da equipa, fica só com campos úteis
 *   (sem ids nem contactos) e converte o tom de 0–100 em palavras;
 * - saída: tira markdown, aplica a saudação e a assinatura da empresa, calcula o assunto e
 *   encontra os marcadores (`[DATA]`) que o agente tem de preencher.
 */

export type Obj = Record<string, unknown>;

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Limites (em caracteres) de cada parte da mensagem. */
export const LIMITS = {
  selected: 6000,
  email: 1200,
  emails: 5,
  comment: 600,
  comments: 5,
  organization: 1500,
  field: 300,
  description: 2000,
  houseRule: 300,
  houseRules: 20,
} as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

const mask = (text: string): string => text.replace(EMAIL_IN_TEXT, '[email]');

/** `dd/mm/aaaa`, ou `undefined` sem data válida. */
function day(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear())}`;
}

const time = (v: unknown): number => {
  const t = new Date(str(v) ?? '').getTime();
  return Number.isNaN(t) ? 0 : t;
};

// ---------- emails ----------

/** Onde começa o histórico citado de um email (respostas anteriores incluídas no corpo). */
const QUOTE_START = [
  /^\s*>/,
  /^\s*On .{3,200} wrote:\s*$/i,
  /^\s*Em .{3,200} escreveu:\s*$/i,
  /^\s*-{2,}\s*(Original Message|Mensagem original|Forwarded message|Mensagem encaminhada)/i,
  /^\s*(From|De):\s.+/i,
  /^\s*_{10,}\s*$/,
];

/** Referências técnicas do Salesforce no texto (`thread::…::`, `ref:_…:ref`). */
const THREAD_REF = /thread::[A-Za-z0-9_-]+::|ref:_[A-Za-z0-9._]+:ref/g;

/**
 * O texto útil de um email: sem o histórico citado, sem referências de thread, sem a
 * assinatura depois de `-- `, emails mascarados e linhas em branco a mais retiradas.
 */
export function cleanEmailBody(text: string, max: number = LIMITS.email): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(THREAD_REF, '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (/^--\s*$/.test(line)) break;
    kept.push(line.trimEnd());
  }
  const body = mask(kept.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cut(body, max);
}

export interface ConversationEmail {
  incoming: boolean;
  date: string | undefined;
  at: number;
  text: string;
  /** Quantas respostas da equipa anteriores e seguidas foram juntadas a esta. */
  repeats: number;
}

/**
 * A conversa sem o email selecionado: do mais recente para o mais antigo, com o corpo limpo e
 * sem saudação nem despedida, as respostas seguidas da equipa juntadas na mais recente, e no
 * máximo `LIMITS.emails`.
 */
export function conversation(
  emails: Obj[] | null | undefined,
  selected: { id?: string | undefined; body: string },
): ConversationEmail[] {
  const items = (emails ?? [])
    .filter((e) => {
      if (selected.id !== undefined && e['id'] === selected.id) return false;
      const body = str(e['textBody']) ?? str(e['body']) ?? '';
      // Sem id, o selecionado reconhece-se pelo texto.
      return body !== '' && cleanEmailBody(body) !== cleanEmailBody(selected.body);
    })
    .map((e) => ({
      incoming: e['incoming'] === true,
      date: day(e['messageDate'] ?? e['createdDate']),
      at: time(e['messageDate'] ?? e['createdDate']),
      text: removeClosing(
        removeGreeting(cleanEmailBody(str(e['textBody']) ?? str(e['body']) ?? '')),
      ),
      repeats: 0,
    }))
    .filter((e) => e.text !== '')
    .sort((a, b) => b.at - a.at);

  // Respostas seguidas da equipa, sem mensagem do cliente pelo meio, dizem quase sempre o mesmo
  // ("está em análise…"): fica a mais recente, com a contagem das outras.
  const merged: ConversationEmail[] = [];
  for (const e of items) {
    const prev = merged[merged.length - 1];
    if (!e.incoming && prev !== undefined && !prev.incoming) prev.repeats++;
    else merged.push(e);
  }
  return merged.slice(0, LIMITS.emails);
}

// ---------- tom ----------

const level = (v: unknown, low: string, mid: string, high: string): string | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v < 35 ? low : v <= 65 ? mid : high;
};

/** Os três eixos de 0 a 100 em palavras, para o modelo e para `recommendedTone`. */
export function toneText(tone: Obj | null | undefined): string {
  const t = tone ?? {};
  const parts = [
    level(t['tom'] ?? t['tone'], 'tom neutro', 'tom equilibrado', 'tom caloroso'),
    level(t['simpatia'] ?? t['empathy'], 'direto', 'simpatia moderada', 'empático'),
    level(t['formalidade'] ?? t['formality'], 'informal', 'formalidade média', 'formal'),
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? 'profissional e cordial' : parts.join(' · ');
}

// ---------- dados do registo ----------

const CASE_FIELDS: [key: string, label: string][] = [
  ['status', 'Estado'],
  ['priority', 'Prioridade'],
  ['origin', 'Origem'],
  ['type', 'Tipo'],
];
const TYPIFICATION = ['irisTipo', 'irisSubTipo', 'irisClassificacao', 'irisSubClassificacao'];

/** Campos extra do administrador (`[{ field, label, value }]`) como `label: valor`. */
export function contextFields(list: Obj[] | null | undefined): string[] {
  return (list ?? [])
    .map((f) => {
      const label = str(f['label']) ?? str(f['field']);
      const v = f['value'];
      const value =
        typeof v === 'number' || typeof v === 'boolean' ? String(v) : (str(v) ?? undefined);
      return label === undefined || value === undefined
        ? undefined
        : `${label}: ${cut(mask(value), LIMITS.field)}`;
    })
    .filter((l): l is string => l !== undefined);
}

function personName(contact: Obj | null | undefined): string | undefined {
  if (contact === null || contact === undefined) return undefined;
  return (
    str(contact['name']) ??
    ([str(contact['firstName']), str(contact['lastName'])].filter(Boolean).join(' ') || undefined)
  );
}

// ---------- a mensagem ----------

export interface ReplyInputView {
  payload: {
    selectedItem: Obj;
    toneParams?: Obj | null | undefined;
    replySettings?: Obj | null | undefined;
  };
  organizationContext?: string | null | undefined;
  case?: Obj | null | undefined;
  account?: Obj | null | undefined;
  contact?: Obj | null | undefined;
  caseContextFields?: Obj[] | null | undefined;
  accountContextFields?: Obj[] | null | undefined;
  contactContextFields?: Obj[] | null | undefined;
  caseComments?: Obj[] | null | undefined;
  emailMessages?: Obj[] | null | undefined;
}

export const settingsOf = (input: ReplyInputView) => {
  const s = input.payload.replySettings ?? {};
  const rules = Array.isArray(s['houseRules']) ? (s['houseRules'] as unknown[]) : [];
  return {
    hasGreeting: s['hasGreeting'] === true,
    hasSignature: s['hasSignature'] === true,
    houseRules: rules
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter((r) => r !== '')
      .slice(0, LIMITS.houseRules)
      .map((r) => cut(r, LIMITS.houseRule)),
  };
};

/** A mensagem para o modelo: só o que serve para escrever a resposta, por ordem de importância. */
export function buildReplyMessage(input: ReplyInputView): string {
  const item = input.payload.selectedItem;
  const selectedBody = str(item['body']) ?? str(item['textBody']) ?? str(item['preview']) ?? '';
  const settings = settingsOf(input);
  const c = input.case ?? {};
  const out: string[] = [];

  // 1. A mensagem a que se responde.
  const when = day(item['createdDate'] ?? item['messageDate']);
  out.push(`MENSAGEM DO CLIENTE A QUE RESPONDES${when === undefined ? '' : ` (${when})`}:`);
  const title = str(item['title']) ?? str(item['subject']);
  if (title !== undefined) out.push(`Assunto: ${mask(title)}`);
  out.push(cleanEmailBody(selectedBody, LIMITS.selected) || '(sem texto)');

  // 2. Forma da resposta.
  out.push('');
  const name = personName(input.contact);
  out.push(
    `FORMATO: ${
      settings.hasGreeting
        ? 'NÃO escrever saudação (a empresa acrescenta a sua); começar no conteúdo.'
        : `escrever uma saudação adequada ao tom${name === undefined ? '' : `, ao cliente ${name}`}.`
    } ${
      settings.hasSignature
        ? 'NÃO escrever despedida nem assinatura (a empresa acrescenta); terminar no conteúdo.'
        : 'Escrever uma despedida curta, sem nome de pessoa (assinar como a equipa).'
    }`,
  );
  out.push(`TOM: ${toneText(input.payload.toneParams)}`);

  // 3. Regras e empresa.
  if (settings.houseRules.length > 0) {
    out.push('', 'REGRAS DA EMPRESA (obrigatórias):');
    for (const r of settings.houseRules) out.push(`- ${r}`);
  }
  const org = str(input.organizationContext);
  if (org !== undefined) out.push('', `EMPRESA: ${cut(org, LIMITS.organization)}`);

  // 4. O Case, só com o que ajuda a responder.
  out.push('');
  const head = [
    str(c['caseNumber']) === undefined ? 'CASE' : `CASE #${String(c['caseNumber'])}`,
    ...CASE_FIELDS.map(([k, l]) => (str(c[k]) === undefined ? undefined : `${l}: ${String(c[k])}`)),
  ].filter((p): p is string => p !== undefined);
  out.push(head.join(' · '));
  const typification = TYPIFICATION.map((k) => str(c[k])).filter(
    (v): v is string => v !== undefined,
  );
  if (typification.length > 0) out.push(`Tipificação: ${typification.join(' › ')}`);
  const subject = str(c['subject']);
  if (subject !== undefined) out.push(`Assunto do Case: ${mask(subject)}`);
  const description = str(c['description']);
  if (description !== undefined)
    out.push(`Descrição: ${cut(mask(description), LIMITS.description)}`);
  const account = str(input.account?.['name']);
  if (name !== undefined || account !== undefined)
    out.push(
      `Cliente: ${[name, account === undefined ? undefined : `(${account})`].filter(Boolean).join(' ')}`,
    );
  const extra = [
    ...contextFields(input.caseContextFields),
    ...contextFields(input.accountContextFields),
    ...contextFields(input.contactContextFields),
  ];
  for (const line of extra) out.push(line);

  // 5. O que a equipa já disse ao cliente.
  const history = conversation(input.emailMessages, {
    id: str(item['id']),
    body: selectedBody,
  });
  const selectedAt = time(item['createdDate'] ?? item['messageDate']);
  const sinceSelected = history.filter((e) => !e.incoming && e.at > selectedAt);
  const answers = sinceSelected.reduce((n, e) => n + 1 + e.repeats, 0);
  if (answers > 0) {
    const last = sinceSelected[0];
    out.push(
      '',
      `JÁ RESPONDIDO PELA EQUIPA A ESTA MENSAGEM: ${String(answers)} vez(es), a última em ${last?.date ?? 'data desconhecida'}.`,
      'Não repitas o que já foi dito: avança com informação nova se o contexto a tiver; se não tiver, sê breve e indica em missingInfo o que falta ao agente.',
    );
  }
  if (history.length > 0) {
    out.push('', 'CONVERSA ANTERIOR (mais recente primeiro):');
    for (const e of history) {
      const who = e.incoming ? 'cliente' : 'equipa';
      const rep = e.repeats > 0 ? `, mais recente de ${String(e.repeats + 1)} seguidas` : '';
      out.push(`[${who}, ${e.date ?? 's/ data'}${rep}] ${e.text.replace(/\n+/g, ' ')}`);
    }
  }

  // 6. Notas da equipa: contexto, nunca para citar.
  const comments = (input.caseComments ?? [])
    .map((cm) => ({
      at: time(cm['createdDate']),
      date: day(cm['createdDate']),
      published: cm['isPublished'] === true,
      text: cut(mask(str(cm['body']) ?? str(cm['commentBody']) ?? ''), LIMITS.comment),
    }))
    .filter((cm) => cm.text !== '')
    .sort((a, b) => b.at - a.at)
    .slice(0, LIMITS.comments);
  if (comments.length > 0) {
    out.push('', 'NOTAS DA EQUIPA (contexto; não citar nem revelar ao cliente):');
    for (const cm of comments)
      out.push(
        `[${cm.date ?? 's/ data'}, ${cm.published ? 'publicado' : 'interno'}] ${cm.text.replace(/\n+/g, ' ')}`,
      );
  }

  return out.join('\n');
}

// ---------- a resposta ----------

const GREETING =
  /^(car[oa]s?|car[oa]\(a\)|caros\(as\)|exm[oa]s?\.?|ex\.?m[oa]s?\.?|prezad[oa]s?|ol[aá]|bom dia|boa tarde|boa noite|dear|hello|hi|good (morning|afternoon|evening))\b/i;
const CLOSING =
  /^(com os (melhores )?cumprimentos|(os )?melhores cumprimentos|cumprimentos|atenciosamente|com estima|saudações|obrigad[oa]s?|muito obrigad[oa]|best regards|kind regards|regards|sincerely|thank you|thanks)\b/i;

/** Tira o markdown que o modelo às vezes escreve, mantendo o texto. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^```[a-z]*\n?|```$/gim, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Tira a saudação do início: uma linha curta, ou o vocativo antes da primeira vírgula. */
export function removeGreeting(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  if (!GREETING.test(first.trim())) return text;
  const line = first.trim();
  if (line.length <= 60 && /[,!:]?$/.test(line) && (rest.length > 0 || line.length <= 40)) {
    // "Cara Rose," numa linha própria.
    if (/[,!:]$/.test(line) || line.split(/\s+/).length <= 4)
      return rest.join('\n').replace(/^\n+/, '').trim();
  }
  // "Cara Rose, compreendemos…" na mesma linha.
  const comma = line.indexOf(',');
  if (comma > 0 && comma <= 40) {
    const after = line.slice(comma + 1).trim();
    const sentence = after.charAt(0).toUpperCase() + after.slice(1);
    return [sentence, ...rest].join('\n').trim();
  }
  return text;
}

/** Tira a despedida e o que vem a seguir (nome, cargo), se estiver nas últimas linhas. */
export function removeClosing(text: string): string {
  const lines = text.split('\n');
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (CLOSING.test(line) && line.length <= 80) {
      // "Obrigado" no meio de uma frase longa não é despedida.
      if (/^obrigad|^muito obrigad|^thank/i.test(line) && line.length > 40) continue;
      return lines.slice(0, i).join('\n').trim();
    }
  }
  return text;
}

/** O assunto da resposta: `RE: ` mais o assunto original, sem repetir prefixos. */
export function replySubject(original: string | undefined): string {
  const base = (original ?? '').replace(/^\s*((re|res|fw|fwd|enc|tr)\s*:\s*)+/i, '').trim();
  return base === '' ? 'RE:' : `RE: ${base}`;
}

/** Os marcadores que o agente tem de preencher (`[DATA]`, `[NÚMERO DA ENCOMENDA]`…). */
export function placeholdersIn(text: string): string[] {
  const found = text.match(/\[[A-ZÀ-Ý0-9][A-ZÀ-Ý0-9 _/-]{1,40}\]/g) ?? [];
  return [...new Set(found.filter((p) => p !== '[email]'))];
}
