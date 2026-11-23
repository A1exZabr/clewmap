import type { Language, Range } from '@clewmap/core';
import type { Node } from 'web-tree-sitter';
import { rangeOf } from './adapters/common.js';
import { parse, type SupportedLanguage } from './parser.js';

/** Оператор верхнего уровня тела функции — сырьё для смысловых блоков (CodeBlock). */
export interface Statement {
  index: number;
  range: Range;
  type: string;
  text: string;
}

const FUNCTION_NODES = new Set([
  'function_definition',
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'function',
]);

function bodyOf(fn: Node): Node | null {
  return fn.childForFieldName('body');
}

function isDocstring(node: Node, index: number, language: Language): boolean {
  return (
    language === 'python' &&
    index === 0 &&
    node.type === 'expression_statement' &&
    node.namedChildren.length === 1 &&
    node.namedChildren[0]!.type === 'string'
  );
}

/**
 * Операторы верхнего уровня тела функции. Вложенные if/for/try/with — один оператор целиком.
 * Комментарии и докстринг не считаются. Тело-выражение стрелочной функции — один оператор.
 */
export function extractStatements(fn: Node, language: Language): Statement[] {
  const body = bodyOf(fn);
  if (!body) return [];
  if (body.type !== 'block' && body.type !== 'statement_block') {
    return [{ index: 0, range: rangeOf(body), type: body.type, text: body.text }];
  }
  const out: Statement[] = [];
  let i = 0;
  for (const child of body.namedChildren) {
    if (child.type === 'comment') continue;
    if (isDocstring(child, i, language)) {
      i++;
      continue;
    }
    out.push({ index: out.length, range: rangeOf(child), type: child.type, text: child.text });
    i++;
  }
  return out;
}

/** Находит функцию, начинающуюся в диапазоне символа (с учётом декораторов и export), и возвращает её операторы. */
export async function statementsForRange(
  source: string,
  grammar: SupportedLanguage,
  language: Language,
  range: Range,
): Promise<Statement[]> {
  const tree = await parse(source, grammar);
  try {
    let found: Node | null = null;
    const visit = (node: Node): void => {
      if (found) return;
      if (node.endPosition.row < range.start[0] || node.startPosition.row > range.end[0]) return;
      if (FUNCTION_NODES.has(node.type) && node.endPosition.row <= range.end[0]) {
        found = node;
        return;
      }
      for (const c of node.namedChildren) visit(c);
    };
    visit(tree.rootNode);
    return found ? extractStatements(found, language) : [];
  } finally {
    tree.delete();
  }
}
