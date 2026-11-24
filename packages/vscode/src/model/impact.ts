import { diffModules, type GraphIndex, type ModuleFile } from '@clewmap/core';
import type { LastCommit } from './hover.js';

/** Что поменял коммит, по версиям модулей графа до и после него. */
export function changesBetween(
  pairs: Iterable<{ before: ModuleFile | null; after: ModuleFile | null }>,
): LastCommit['changed'] {
  const changed: LastCommit['changed'] = new Map();
  for (const { before, after } of pairs) {
    const d = diffModules(before, after);
    for (const id of d.added) changed.set(id, 'added');
    for (const id of d.bodyChanged) changed.set(id, 'body');
    for (const id of d.signatureChanged) if (!changed.has(id)) changed.set(id, 'signature');
  }
  return changed;
}

export interface ImpactView {
  sha: string | null;
  subject: string;
  changed: { id: string; kind: 'added' | 'body' | 'signature' }[];
  /** Транзитивно затронутые вызывающие, глубина до 3. */
  affected: { id: string; depth: number }[];
  /** Символы с описанием, помеченным устаревшим (поменялась сигнатура того, что они вызывают). */
  stale: string[];
  /** Символы без описания (функции, методы, классы). */
  missing: number;
}

export function impactView(index: GraphIndex, last: LastCommit | null): ImpactView {
  const changed = last
    ? [...last.changed]
        .filter(([id]) => index.get(id))
        .map(([id, kind]) => ({ id, kind }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    : [];
  const affected = index.impact(
    changed.map((c) => c.id),
    3,
  );
  const stale: string[] = [];
  let missing = 0;
  for (const s of index.symbols.values()) {
    if (s.kind === 'variable') continue;
    if (s.summary && s.summary.forBodyHash === s.bodyHash && s.summary.stale) stale.push(s.id);
    if (!s.summary || s.summary.forBodyHash !== s.bodyHash) missing++;
  }
  return {
    sha: last?.sha ?? null,
    subject: last?.subject ?? '',
    changed,
    affected,
    stale: stale.sort(),
    missing,
  };
}
