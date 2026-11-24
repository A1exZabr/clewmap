import type { SummaryBlockResult, SummaryRequest, SummaryResult } from './types.js';

const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'Russian',
  en: 'English',
  uk: 'Ukrainian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  pl: 'Polish',
  tr: 'Turkish',
  ka: 'Georgian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

export const MIN_BLOCKS = 2;
export const MAX_BLOCKS = 7;

/** Сколько символов кода отдавать модели на один символ: огромный класс не должен съесть пачку. */
const MAX_CODE_CHARS = 12_000;

export const SYSTEM_PROMPT =
  'You write short plain-language descriptions of source code for a code map shown next to the code in an editor. You answer with JSON only.';

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

function entryText(r: SummaryRequest): string | null {
  if (!r.entry) return null;
  const kinds: Record<string, string> = {
    'http-route': 'HTTP route',
    'bot-callback': 'bot button handler',
    'bot-command': 'bot command handler',
    event: 'event handler',
  };
  return `${kinds[r.entry.kind] ?? r.entry.kind} ${r.entry.key}`;
}

function oneLine(text: string, max = 110): string {
  const first = text.split('\n')[0]!.trim();
  const more = text.includes('\n') ? ' …' : '';
  return first.length > max ? `${first.slice(0, max)}…` : `${first}${more}`;
}

function symbolSection(r: SummaryRequest): string {
  const lines: string[] = [`### ${r.id}`];
  lines.push(`kind: ${r.kind}; file: ${r.file}${r.layer ? `; layer: ${r.layer}` : ''}`);
  const entry = entryText(r);
  if (entry) lines.push(`entry point: ${entry}`);
  lines.push(`signature: ${r.signature}`);
  if (r.callees.length) {
    lines.push('calls:');
    for (const c of r.callees) {
      const via = c.via ? ` [${c.via}]` : '';
      lines.push(`- ${c.name}${via}${c.summary ? `: ${c.summary}` : ''}`);
    }
  }
  const code =
    r.code.length > MAX_CODE_CHARS ? `${r.code.slice(0, MAX_CODE_CHARS)}\n… (truncated)` : r.code;
  lines.push('code:', '```' + r.language, code, '```');
  if (r.statements) {
    lines.push('statements:');
    for (const s of r.statements) lines.push(`[${s.index}] line ${s.line + 1}: ${oneLine(s.text)}`);
  }
  return lines.join('\n');
}

/** Промпт на пачку символов. Контекст узкий: код, сигнатура, вызываемые на 1 шаг, файл и слой. */
export function buildPrompt(batch: readonly SummaryRequest[], language: string): string {
  const lang = languageName(language);
  const withBlocks = batch.some((r) => r.statements);
  const rules = [
    `Describe each symbol below. Write every text in ${lang}.`,
    '',
    'Answer with a JSON array only, no prose and no code fences, one object per symbol:',
    withBlocks
      ? '[{"id": "<id from the ### header>", "summary": "...", "blocks": [{"from": 0, "to": 2, "label": "...", "text": "..."}]}]'
      : '[{"id": "<id from the ### header>", "summary": "..."}]',
    '',
    '"summary" rules:',
    '- 1–3 short sentences in plain language: what it does and what it returns.',
    '- Name side effects explicitly: database reads/writes, network calls, files, messages sent to users.',
    '- Do not retell the code line by line and do not repeat the name or the signature.',
    '- Use the descriptions of called functions to explain the effect, not to list the calls.',
  ];
  if (withBlocks) {
    rules.push(
      '',
      '"blocks" rules (only for symbols with a "statements" list; omit "blocks" for the others):',
      `- Split the numbered statements into ${MIN_BLOCKS}–${MAX_BLOCKS} meaningful steps.`,
      '- Blocks go in order, cover every statement exactly once, without gaps or overlaps: the first starts at 0, each next one starts right after the previous "to", the last ends at the last statement.',
      '- "label": a 2–5 word name of the step; "text": one sentence on what the step does.',
    );
  }
  return [...rules, '', ...batch.map(symbolSection)].join('\n');
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    if (start === -1 || end <= start) throw new Error('model answer has no JSON');
    return JSON.parse(body.slice(start, end + 1));
  }
}

/** Проверка блоков: подряд, без дыр и пересечений, покрывают все операторы, 2–7 штук. Иначе null. */
export function validateBlocks(raw: unknown, statementCount: number): SummaryBlockResult[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_BLOCKS || raw.length > MAX_BLOCKS) return null;
  const blocks: SummaryBlockResult[] = [];
  let expected = 0;
  for (const b of raw as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') return null;
    const from = b.from;
    const to = b.to;
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (!Number.isInteger(from) || !Number.isInteger(to) || !label) return null;
    if (from !== expected || (to as number) < (from as number)) return null;
    const text = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null;
    blocks.push({ from: from as number, to: to as number, label, text });
    expected = (to as number) + 1;
  }
  return expected === statementCount ? blocks : null;
}

/**
 * Разбор ответа модели. Чужие id и пустые описания отбрасываются;
 * невалидные блоки отбрасываются, описание остаётся.
 */
export function parseResponse(text: string, batch: readonly SummaryRequest[]): SummaryResult[] {
  let data = extractJson(text);
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    data = obj.items ?? obj.results ?? obj.symbols ?? [obj];
  }
  if (!Array.isArray(data)) throw new Error('model answer is not a JSON array');
  const byId = new Map(batch.map((r) => [r.id, r]));
  const out: SummaryResult[] = [];
  const seen = new Set<string>();
  for (const item of data as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const req = byId.get(id);
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    if (!req || !summary || seen.has(id)) continue;
    seen.add(id);
    const result: SummaryResult = { id, summary };
    if (req.statements) result.blocks = validateBlocks(item.blocks, req.statements.length);
    out.push(result);
  }
  return out;
}
