import type { Range } from '@clewmap/core';
import type { Node } from 'web-tree-sitter';

export function rangeOf(node: Node): Range {
  return {
    start: [node.startPosition.row, node.startPosition.column],
    end: [node.endPosition.row, node.endPosition.column],
  };
}

/** Схлопывает пробелы и переносы: для подписей. */
export function collapse(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*\)/g, ')')
    .trim();
}

/**
 * Значение строкового литерала, если в нём нет подстановок.
 * Python: "x", 'x', f"x" без {...}. TS: "x", 'x', `x` без ${...}.
 * Шаблон с подстановками возвращается с ними как есть: `/api/orders/${id}` → "/api/orders/${id}".
 */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'template_string') {
    const m = /^[a-zA-Z]*("""|'''|"|'|`)([\s\S]*)\1$/.exec(node.text);
    return m ? m[2]! : null;
  }
  return null;
}

/** Цепочка имён для identifier / attribute / member_expression; [] для всего остального. */
export function memberPath(node: Node | null | undefined): string[] {
  if (!node) return [];
  switch (node.type) {
    case 'identifier':
    case 'property_identifier':
    case 'type_identifier':
    case 'shorthand_property_identifier':
      return [node.text];
    case 'this':
      return ['this'];
    case 'super':
      return ['super'];
    case 'attribute': {
      const obj = memberPath(node.childForFieldName('object'));
      const attr = node.childForFieldName('attribute');
      return obj.length && attr ? [...obj, attr.text] : [];
    }
    case 'member_expression': {
      const obj = memberPath(node.childForFieldName('object'));
      const prop = node.childForFieldName('property');
      return obj.length && prop ? [...obj, prop.text] : [];
    }
    case 'non_null_expression':
    case 'parenthesized_expression':
      return node.namedChildren.length === 1 ? memberPath(node.namedChildren[0]) : [];
    default:
      return [];
  }
}

/** Выбирает внешнюю обёртку узла определения (декоратор, export), чтобы диапазон начинался с неё. */
export function outerNode(node: Node, wrappers: readonly string[]): Node {
  let cur = node;
  while (cur.parent && wrappers.includes(cur.parent.type)) cur = cur.parent;
  return cur;
}
