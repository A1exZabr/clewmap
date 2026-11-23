import type { Node, Tree } from 'web-tree-sitter';
import { tsCallLink, tsRegistration } from '../links.js';
import { collapse, memberPath, rangeOf, stringValue } from './common.js';
import type {
  AdapterContext,
  LanguageAdapter,
  RawCall,
  RawImport,
  RawRegistration,
  RawSymbol,
} from './types.js';

const FUNCTION_DECLS = ['function_declaration', 'generator_function_declaration'];
const CLASS_DECLS = ['class_declaration', 'abstract_class_declaration', 'class'];
const FUNCTION_VALUES = ['arrow_function', 'function_expression', 'function', 'generator_function'];
const VAR_DECLS = ['lexical_declaration', 'variable_declaration'];

function paramsOf(fn: Node): string {
  const params = fn.childForFieldName('parameters');
  if (params) return params.text;
  const single = fn.childForFieldName('parameter');
  return single ? `(${single.text})` : '()';
}

function fnSignature(name: string, fn: Node): string {
  const ret = fn.childForFieldName('return_type');
  return collapse(`${name}${paramsOf(fn)}${ret ? ret.text : ''}`);
}

function classSignature(name: string, cls: Node): string {
  const heritage = cls.namedChildren.find((c) => c.type === 'class_heritage');
  return collapse(`class ${name}${heritage ? ` ${heritage.text}` : ''}`);
}

function parseImport(node: Node): RawImport[] {
  const source = stringValue(node.childForFieldName('source'));
  if (source === null) return [];
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return [];
  const out: RawImport[] = [];
  for (const part of clause.namedChildren) {
    if (part.type === 'identifier') {
      out.push({ local: part.text, module: source, imported: 'default' });
    } else if (part.type === 'namespace_import') {
      const id = part.namedChildren.find((c) => c.type === 'identifier');
      if (id) out.push({ local: id.text, module: source, imported: null });
    } else if (part.type === 'named_imports') {
      for (const spec of part.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name')?.text;
        const alias = spec.childForFieldName('alias')?.text;
        if (name) out.push({ local: alias ?? name, module: source, imported: name });
      }
    }
  }
  return out;
}

export const typescriptAdapter: LanguageAdapter = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],

  extract(tree: Tree, _source: string, ctx: AdapterContext) {
    const root = tree.rootNode;
    const symbols: RawSymbol[] = [];
    const imports: RawImport[] = [];
    const registrations: RawRegistration[] = [];
    const exports = new Map<string, string>();
    const starExports: string[] = [];

    function pushCall(
      owner: RawSymbol | null,
      callee: string[],
      line: number,
      node: Node | null,
    ): void {
      if (node) {
        const reg = tsRegistration(node, ctx.httpClients);
        if (reg) registrations.push(reg);
      }
      if (!owner) return;
      const call: RawCall = { callee, line };
      if (node) {
        const link = tsCallLink(node, ctx.httpClients);
        if (link) call.link = link;
      }
      owner.calls.push(call);
    }

    /** Обход с текущим владельцем вызовов. Вложенные функции (обработчики внутри компонента) — часть внешней. */
    function walk(node: Node, owner: RawSymbol | null): void {
      switch (node.type) {
        case 'call_expression':
          pushCall(
            owner,
            memberPath(node.childForFieldName('function')),
            node.startPosition.row,
            node,
          );
          break;
        case 'new_expression':
          pushCall(
            owner,
            memberPath(node.childForFieldName('constructor')),
            node.startPosition.row,
            null,
          );
          break;
        case 'jsx_opening_element':
        case 'jsx_self_closing_element': {
          // <CheckoutButton /> — компонент вызывается при рендере. Теги html (div, button) пропускаем.
          const name = memberPath(node.childForFieldName('name'));
          if (name.length && /^[A-Z]/.test(name[name.length - 1]!)) {
            pushCall(owner, name, node.startPosition.row, null);
          }
          break;
        }
      }
      for (const child of node.namedChildren) walk(child, owner);
    }

    function makeSymbol(
      qualified: string,
      name: string,
      kind: RawSymbol['kind'],
      outer: Node,
      signature: string,
      parentClass?: string,
    ): RawSymbol {
      const sym: RawSymbol = {
        qualified,
        name,
        kind,
        range: rangeOf(outer),
        signature,
        body: outer.text,
        calls: [],
      };
      if (parentClass) sym.parentClass = parentClass;
      symbols.push(sym);
      return sym;
    }

    function addClass(cls: Node, outer: Node, nameOverride?: string): RawSymbol | null {
      const name = cls.childForFieldName('name')?.text ?? nameOverride;
      if (!name) return null;
      const sym = makeSymbol(name, name, 'class', outer, classSignature(name, cls));
      for (const c of cls.namedChildren) {
        if (c.type === 'class_heritage') walk(c, sym);
      }
      const body = cls.childForFieldName('body');
      for (const member of body?.namedChildren ?? []) {
        // TS: public_field_definition(name), JS: field_definition(property)
        const mname = (member.childForFieldName('name') ?? member.childForFieldName('property'))
          ?.text;
        if (member.type === 'method_definition' && mname) {
          const m = makeSymbol(
            `${name}.${mname}`,
            mname,
            'method',
            member,
            fnSignature(mname, member),
            name,
          );
          walk(member, m);
          continue;
        }
        const value = member.childForFieldName('value');
        if (
          (member.type === 'public_field_definition' || member.type === 'field_definition') &&
          mname &&
          value &&
          FUNCTION_VALUES.includes(value.type)
        ) {
          const m = makeSymbol(
            `${name}.${mname}`,
            mname,
            'method',
            member,
            fnSignature(mname, value),
            name,
          );
          walk(value, m);
          continue;
        }
        walk(member, sym);
      }
      return sym;
    }

    function addFunction(fn: Node, outer: Node, nameOverride?: string): RawSymbol | null {
      const name = fn.childForFieldName('name')?.text ?? nameOverride;
      if (!name) return null;
      const sym = makeSymbol(name, name, 'function', outer, fnSignature(name, fn));
      walk(fn, sym);
      return sym;
    }

    /** Объявление верхнего уровня; возвращает имена созданных символов. */
    function addDeclaration(decl: Node, outer: Node): string[] {
      if (FUNCTION_DECLS.includes(decl.type)) {
        const s = addFunction(decl, outer);
        return s ? [s.name] : [];
      }
      if (CLASS_DECLS.includes(decl.type)) {
        const s = addClass(decl, outer);
        return s ? [s.name] : [];
      }
      if (VAR_DECLS.includes(decl.type)) {
        const declarators = decl.namedChildren.filter((c) => c.type === 'variable_declarator');
        const names: string[] = [];
        for (const d of declarators) {
          const nameNode = d.childForFieldName('name');
          if (nameNode?.type !== 'identifier') {
            walk(d, null);
            continue;
          }
          const name = nameNode.text;
          const value = d.childForFieldName('value');
          const symOuter = declarators.length === 1 ? outer : d;
          if (value && FUNCTION_VALUES.includes(value.type)) {
            const sym = makeSymbol(name, name, 'function', symOuter, fnSignature(name, value));
            walk(value, sym);
          } else if (value && CLASS_DECLS.includes(value.type)) {
            addClass(value, symOuter, name);
          } else {
            const type = d.childForFieldName('type');
            const sym = makeSymbol(
              name,
              name,
              'variable',
              symOuter,
              collapse(`${name}${type ? type.text : ''}`),
            );
            if (value?.type === 'new_expression') {
              const ctor = memberPath(value.childForFieldName('constructor'));
              if (ctor.length) sym.instanceOf = ctor;
            }
            if (value) walk(value, sym);
          }
          names.push(name);
        }
        return names;
      }
      walk(decl, null);
      return [];
    }

    for (const stmt of root.namedChildren) {
      if (stmt.type === 'import_statement') {
        imports.push(...parseImport(stmt));
        continue;
      }

      if (stmt.type === 'export_statement') {
        const isDefault = stmt.children.some((c) => c.type === 'default');
        const decl = stmt.childForFieldName('declaration');
        const value = stmt.childForFieldName('value');
        const source = stringValue(stmt.childForFieldName('source'));
        const clause = stmt.namedChildren.find((c) => c.type === 'export_clause');

        if (decl) {
          const names = addDeclaration(decl, stmt);
          for (const n of names) exports.set(n, n);
          if (isDefault && names[0]) exports.set('default', names[0]);
        } else if (value) {
          if (value.type === 'identifier') {
            exports.set('default', value.text);
          } else if (FUNCTION_VALUES.includes(value.type)) {
            const s = addFunction(value, stmt, 'default');
            if (s) exports.set('default', s.name);
          } else if (CLASS_DECLS.includes(value.type)) {
            const s = addClass(value, stmt, 'default');
            if (s) exports.set('default', s.name);
          } else {
            const s = makeSymbol('default', 'default', 'variable', stmt, 'default');
            walk(value, s);
            exports.set('default', 'default');
          }
        } else if (clause) {
          for (const spec of clause.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name')?.text;
            const alias = spec.childForFieldName('alias')?.text;
            if (!name) continue;
            if (source !== null) {
              // export { a as b } from './x' — реэкспорт через локальную привязку импорта
              const local = `__reexport__${alias ?? name}`;
              imports.push({ local, module: source, imported: name });
              exports.set(alias ?? name, local);
            } else {
              exports.set(alias ?? name, name);
            }
          }
        } else if (source !== null) {
          const ns = stmt.namedChildren.find((c) => c.type === 'namespace_export');
          if (ns) {
            const id = ns.namedChildren[0]?.text;
            if (id) {
              imports.push({ local: `__reexport__${id}`, module: source, imported: null });
              exports.set(id, `__reexport__${id}`);
            }
          } else {
            starExports.push(source);
          }
        }
        continue;
      }

      addDeclaration(stmt, stmt);
    }

    return { symbols, imports, exports, starExports, registrations };
  },
};
