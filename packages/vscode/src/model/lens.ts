import type { GraphIndex, IncomingEdge, CallEdge } from '@clewmap/core';
import {
  baseName,
  displayName,
  edgeLayer,
  fileOfId,
  incomingLinks,
  outgoingLinks,
  truncate,
  uniqueCallees,
  uniqueCallers,
  validSummary,
  type LayerInfo,
  type Translate,
} from './graph.js';
import type { LocatedSymbol } from './locate.js';

export const LENS_SUMMARY_CHARS = 90;

export interface LinkLens {
  title: string;
  tooltip: string;
  /** Куда ведёт клик: символ на другой стороне связи и строка связи. */
  target: string;
  line: number | null;
}

export interface LensParts {
  summary: { title: string; tooltip: string | null };
  callers: { title: string; count: number };
  goesTo: { title: string; tooltip: string } | null;
  links: LinkLens[];
}

/** Подпись связи через границу: «кнопка» для событий, «запрос» для HTTP. */
function linkKind(kind: CallEdge['kind'], t: Translate): string {
  return kind === 'event' ? t('button') : t('request');
}

export function incomingLinkLens(e: IncomingEdge, index: GraphIndex, t: Translate): LinkLens {
  const file = index.fileOfSymbol(e.from) ?? fileOfId(e.from);
  const where = `${baseName(file)}:${e.line + 1}`;
  return {
    title: `← ${linkKind(e.kind, t)} ${where}${e.via ? ` · ${e.via}` : ''}`,
    tooltip: t('{0} in {1} leads here', displayName(e.from, index), file),
    target: e.from,
    line: e.line,
  };
}

export function outgoingLinkLens(e: CallEdge, index: GraphIndex, t: Translate): LinkLens {
  const name = e.resolved ? displayName(e.target, index) : t('no handler in this repository');
  return {
    title: `→ ${name}${e.via ? ` · ${e.via}` : ''}`,
    tooltip: e.resolved
      ? t('Handled by {0} in {1}', displayName(e.target, index), fileOfId(e.target))
      : t('No handler for {0} was found in this repository', e.via ?? e.target),
    target: e.target,
    line: null,
  };
}

/**
 * Строка над функцией: описание (до ~90 символов, полное в подсказке), «вызывают: N»,
 * «ходит в: …» (слои и сервисы среди вызываемых) и связи через границу языков.
 */
export function lensParts(
  sym: LocatedSymbol,
  index: GraphIndex,
  layers: Map<string, LayerInfo>,
  t: Translate,
): LensParts {
  const node = sym.node;
  const text = validSummary(node);
  let title: string;
  let tooltip: string | null = text;
  if (!text) {
    title = t('summary is not ready yet');
    tooltip = t('Run clewmap summarize, or wait for the commit hook.');
  } else {
    title = truncate(text, LENS_SUMMARY_CHARS);
    if (node.summary!.stale) {
      title = `${title} · ${t('outdated')}`;
      tooltip = `${text}\n\n${t('Something it calls has changed its signature; the summary will be rewritten.')}`;
    }
  }
  if (!sym.fresh) {
    title = `${title} · ${t('graph is behind this file')}`;
    tooltip =
      `${tooltip ?? ''}\n\n${t('The function was edited after the graph was updated. Commit or run clewmap update.')}`.trim();
  }

  const callers = uniqueCallers(index, node.id).length;

  const callees = uniqueCallees(node);
  let goesTo: LensParts['goesTo'] = null;
  const external = node.calls.filter((e) => !e.resolved && edgeLayer(e, index) === 'external');
  if (callees.length || external.length) {
    const labels: string[] = [];
    for (const e of [...callees, ...external]) {
      const layer = edgeLayer(e, index);
      if (!layer || layer === node.layer) continue;
      const label = layers.get(layer)?.label ?? layer;
      if (!labels.includes(label)) labels.push(label);
    }
    const names = callees.map((e) => displayName(e.target, index, fileOfId(node.id)));
    const shown = labels.length
      ? labels.join(', ')
      : names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    goesTo = {
      title: t('reaches: {0}', shown),
      tooltip: names.length ? names.join(', ') : external.map((e) => e.target).join(', '),
    };
  }

  const links = [
    ...incomingLinks(index, node.id).map((e) => incomingLinkLens(e, index, t)),
    ...outgoingLinks(node).map((e) => outgoingLinkLens(e, index, t)),
  ];

  return {
    summary: { title, tooltip },
    callers: { title: t('callers: {0}', callers), count: callers },
    goesTo,
    links,
  };
}
