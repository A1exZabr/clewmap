import { languageName } from './prompt.js';

/** Сосед символа для «Объяснить подробнее»: имя, отношение, готовое описание из графа. */
export interface ExplainNeighbor {
  id: string;
  name: string;
  /** calls — символ вызывает соседа; calledBy — сосед вызывает символ. */
  relation: 'calls' | 'calledBy';
  depth: number;
  summary: string | null;
  /** Для связей через границу: "POST /api/checkout", "callback:checkout". */
  via?: string;
}

/** Узкий контекст: код символа, описания соседей на 1–2 шага и описание модуля. Без всего проекта. */
export interface ExplainContext {
  id: string;
  name: string;
  kind: string;
  file: string;
  layer: string | null;
  signature: string;
  /** Язык кода: python, typescript, javascript. */
  codeLanguage: string;
  code: string;
  summary: string | null;
  moduleSummary: string | null;
  blocks: { label: string; text: string | null }[] | null;
  neighbors: ExplainNeighbor[];
}

export const EXPLAIN_SYSTEM_PROMPT =
  'You explain one piece of source code to a developer who is reading it in an editor. ' +
  'You only describe what the code does and how it connects to its neighbours; you do not review it, ' +
  'suggest fixes or judge whether the logic is right. Answer in plain Markdown, without a top-level heading.';

const MAX_CODE_CHARS = 20_000;

export function buildExplainPrompt(ctx: ExplainContext, language: string): string {
  const lines: string[] = [
    `Explain \`${ctx.name}\` in more depth than its one-paragraph summary. Write in ${languageName(language)}.`,
    'Cover: what it is for, how it works step by step, what it reads and changes (data, network, state), ' +
      'who calls it and what it relies on, and edge cases visible in the code. Mention only facts the code ' +
      'and the neighbour summaries support. 150–350 words, short paragraphs or a list.',
    '',
    `File: ${ctx.file}${ctx.layer ? ` (layer: ${ctx.layer})` : ''}`,
    `Kind: ${ctx.kind}`,
    `Signature: ${ctx.signature}`,
  ];
  if (ctx.moduleSummary) lines.push(`Module: ${ctx.moduleSummary}`);
  if (ctx.summary) lines.push(`Current summary: ${ctx.summary}`);
  if (ctx.blocks?.length) {
    lines.push('Steps already shown in the editor:');
    ctx.blocks.forEach((b, i) =>
      lines.push(`  ${i + 1}. ${b.label}${b.text ? ` — ${b.text}` : ''}`),
    );
  }
  const group = (relation: ExplainNeighbor['relation'], title: string) => {
    const list = ctx.neighbors.filter((n) => n.relation === relation);
    if (!list.length) return;
    lines.push('', title);
    for (const n of list)
      lines.push(
        `- ${n.id}${n.depth > 1 ? ` (${n.depth} steps away)` : ''}${n.via ? ` via ${n.via}` : ''}: ` +
          (n.summary ?? 'no summary yet'),
      );
  };
  group('calls', 'It calls:');
  group('calledBy', 'It is called by:');
  const code =
    ctx.code.length > MAX_CODE_CHARS ? `${ctx.code.slice(0, MAX_CODE_CHARS)}\n… (cut)` : ctx.code;
  lines.push('', `Code (${ctx.codeLanguage}):`, '```', code, '```');
  return lines.join('\n');
}
