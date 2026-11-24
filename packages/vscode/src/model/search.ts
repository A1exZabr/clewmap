import type { GraphIndex, SymbolNode } from '@clewmap/core';
import { qualifiedOf, validSummary } from './graph.js';

export interface SearchHit {
  id: string;
  score: number;
  /** Совпало в описании, а не в имени. */
  bySummary: boolean;
}

/** Буквы запроса идут в имени по порядку: "crord" ~ "create_order". Чем плотнее и раньше, тем лучше. */
function subsequenceScore(name: string, q: string): number {
  let pos = 0;
  let gaps = 0;
  let first = -1;
  for (const ch of q) {
    const found = name.indexOf(ch, pos);
    if (found === -1) return 0;
    if (first === -1) first = found;
    gaps += found - pos;
    pos = found + 1;
  }
  return Math.max(1, 40 - gaps * 2 - first);
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

/**
 * Нечёткий поиск по именам и по тексту описаний, без модели.
 * Имя: точное совпадение > начало > подстрока > буквы по порядку. Описание: все слова запроса встречаются
 * (как начало слова), так что «промокод» найдёт «промокода» и «промокоды».
 */
export function searchGraph(index: GraphIndex, query: string, limit = 30): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qWords = words(q);
  const hits: SearchHit[] = [];
  for (const s of index.symbols.values()) {
    const name = qualifiedOf(s.id).toLowerCase();
    const short = s.name.toLowerCase();
    let score = 0;
    if (short === q || name === q) score = 100;
    else if (short.startsWith(q) || name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (!q.includes(' ')) score = subsequenceScore(name, q);
    let bySummary = false;
    if (score < 60) {
      const summary = validSummary(s) ?? s.summary?.text ?? '';
      const sw = words(summary);
      if (summary && qWords.every((w) => sw.some((x) => x.startsWith(w)))) {
        score = Math.max(score, 50);
        bySummary = score === 50;
      }
    }
    if (score > 0) hits.push({ id: s.id, score: score + kindBonus(s), bySummary });
  }
  return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

function kindBonus(s: SymbolNode): number {
  return s.kind === 'variable' ? -5 : 0;
}
