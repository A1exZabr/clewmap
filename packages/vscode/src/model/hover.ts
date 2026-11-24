import type { CodeBlock, GraphIndex } from '@clewmap/core';
import {
  baseName,
  displayName,
  fileOfId,
  incomingLinks,
  outgoingLinks,
  uniqueCallees,
  uniqueCallers,
  validSummary,
  type LayerInfo,
  type Translate,
} from './graph.js';
import { incomingLinkLens, outgoingLinkLens } from './lens.js';

/** Последний коммит: какие символы он поменял. */
export interface LastCommit {
  sha: string;
  subject: string;
  /** id → что изменилось. */
  changed: Map<string, 'added' | 'body' | 'signature'>;
}

/** Команды, на которые ссылается подсказка: только их VS Code разрешит выполнить из Markdown. */
export const HOVER_COMMANDS = [
  'clewmap.goto',
  'clewmap.explainDeeper',
  'clewmap.openOnGraph',
  'clewmap.showCallers',
  'clewmap.showCallees',
];

export function commandLink(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** Экранирует текст для Markdown, чтобы описание не превратилось в разметку. */
export function md(text: string): string {
  return text.replace(/([\\`*_{}[\]<>#|~])/g, '\\$1');
}

function badge(layer: LayerInfo): string {
  // VS Code разрешает в подсказках span только с color и background-color.
  return `<span style="color:#111114;background-color:${layer.color};">&nbsp;${md(layer.label)}&nbsp;</span>`;
}

const MAX_LIST = 6;

function nameList(ids: string[], index: GraphIndex, contextFile: string): string {
  const shown = ids
    .slice(0, MAX_LIST)
    .map(
      (id) => `[\`${displayName(id, index, contextFile)}\`](${commandLink('clewmap.goto', [id])})`,
    );
  if (ids.length > MAX_LIST) shown.push(`+${ids.length - MAX_LIST}`);
  return shown.join(', ');
}

/**
 * Подсказка о символе. Только данные графа: никаких запросов к модели, поэтому мгновенно.
 * Имена соседей из того же файла, что и символ, пишутся без модуля (как в макете: `is_expired`).
 */
export function symbolHover(
  id: string,
  index: GraphIndex,
  layers: Map<string, LayerInfo>,
  t: Translate,
  opts: { contextFile: string; lastCommit?: LastCommit | null; edited?: boolean },
): string | null {
  const node = index.get(id);
  if (!node) return null;
  const file = index.fileOfSymbol(id) ?? fileOfId(id);
  const parts: string[] = [];

  const layer = node.layer ? layers.get(node.layer) : undefined;
  const where = `[${md(baseName(file))}:${node.range.start[0] + 1}](${commandLink('clewmap.goto', [id])})`;
  parts.push(
    [`\`${node.signature.replace(/`/g, "'")}\``, layer ? badge(layer) : null, where]
      .filter(Boolean)
      .join(' &nbsp; '),
  );

  const text = validSummary(node);
  if (text) {
    parts.push(md(text) + (node.summary!.stale ? ` _(${md(t('outdated'))})_` : ''));
  } else parts.push(`_${md(t('No summary yet: run clewmap summarize or commit.'))}_`);
  if (opts.edited) parts.push(`_${md(t('The code was edited after the graph was updated.'))}_`);

  const rel: string[] = [];
  const callees = uniqueCallees(node).map((e) => e.target);
  const callers = uniqueCallers(index, id).map((e) => e.from);
  if (callees.length) rel.push(`**${md(t('Calls:'))}** ${nameList(callees, index, file)}`);
  if (callers.length) rel.push(`**${md(t('Called by:'))}** ${nameList(callers, index, file)}`);
  for (const e of incomingLinks(index, id)) {
    const l = incomingLinkLens(e, index, t);
    rel.push(`[${md(l.title)}](${commandLink('clewmap.goto', [l.target, l.line])})`);
  }
  for (const e of outgoingLinks(node)) {
    const l = outgoingLinkLens(e, index, t);
    rel.push(
      e.resolved ? `[${md(l.title)}](${commandLink('clewmap.goto', [l.target])})` : md(l.title),
    );
  }
  if (rel.length) parts.push(rel.join('  \n'));

  const change = opts.lastCommit?.changed.get(id);
  if (change && opts.lastCommit) {
    const what =
      change === 'added'
        ? t('Added in the last commit {0}', opts.lastCommit.sha.slice(0, 7))
        : change === 'signature'
          ? t('Signature changed in the last commit {0}', opts.lastCommit.sha.slice(0, 7))
          : t('Changed in the last commit {0}', opts.lastCommit.sha.slice(0, 7));
    parts.push(
      `> **Δ** ${md(what)}${opts.lastCommit.subject ? `: ${md(opts.lastCommit.subject)}` : ''}`,
    );
  }

  parts.push(
    `[${md(t('Explain in more depth'))}](${commandLink('clewmap.explainDeeper', [id])}) &nbsp;·&nbsp; ` +
      `[${md(t('Open on the graph'))}](${commandLink('clewmap.openOnGraph', [id])})`,
  );
  parts.push(`<sub>${md(t('From the graph, instantly, without asking a model'))}</sub>`);
  return parts.join('\n\n');
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

export function circled(i: number): string {
  return CIRCLED[i] ?? `(${i + 1})`;
}

/** Подсказка по смысловому блоку: номер, подпись и пояснение. */
export function blockHover(fnName: string, block: CodeBlock, i: number, total: number): string {
  const head = `**${circled(i)} ${md(block.label)}** &nbsp; <sub>${i + 1}/${total} · \`${fnName.replace(/`/g, "'")}\`</sub>`;
  return block.text ? `${head}\n\n${md(block.text)}` : head;
}
