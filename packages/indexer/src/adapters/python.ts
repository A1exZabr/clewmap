import type { Node, Tree } from 'web-tree-sitter';
import {
  pythonCallLink,
  pythonDecoratorEntry,
  pythonRegistration,
  pythonRouterPrefix,
} from '../links.js';
import { collapse, memberPath, outerNode, rangeOf } from './common.js';
import type {
  AdapterContext,
  LanguageAdapter,
  RawCall,
  RawImport,
  RawRegistration,
  RawSymbol,
} from './types.js';

const FUNCTION_TYPES = ['function_definition'];
const CLASS_TYPES = ['class_definition'];

function signatureOf(def: Node): string {
  const name = def.childForFieldName('name')?.text ?? '?';
  if (def.type === 'class_definition') {
    const bases = def.childForFieldName('superclasses');
    return collapse(`class ${name}${bases ? bases.text : ''}`);
  }
  const params = def.childForFieldName('parameters')?.text ?? '()';
  const ret = def.childForFieldName('return_type');
  return collapse(`${name}${params}${ret ? ` -> ${ret.text}` : ''}`);
}

function decoratorsOf(def: Node): Node[] {
  const parent = def.parent;
  if (parent?.type !== 'decorated_definition') return [];
  return parent.namedChildren.filter((c) => c.type === 'decorator');
}

function parseImports(node: Node): RawImport[] {
  const out: RawImport[] = [];
  if (node.type === 'import_statement') {
    for (const name of node.childrenForFieldName('name')) {
      if (name.type === 'aliased_import') {
        const mod = name.childForFieldName('name')?.text;
        const alias = name.childForFieldName('alias')?.text;
        if (mod && alias) out.push({ local: alias, module: mod, imported: null });
      } else {
        // import a.b — локальное имя "a", модуль "a"; цепочка a.b.f разрешается при вызове
        const mod = name.text;
        out.push({ local: mod.split('.')[0]!, module: mod.split('.')[0]!, imported: null });
        if (mod.includes('.')) out.push({ local: mod, module: mod, imported: null });
      }
    }
  } else if (node.type === 'import_from_statement') {
    const modNode = node.childForFieldName('module_name');
    if (!modNode) return out;
    let module = modNode.text;
    let level = 0;
    if (modNode.type === 'relative_import') {
      const prefix = modNode.namedChildren.find((c) => c.type === 'import_prefix');
      level = prefix ? prefix.text.length : 0;
      module = modNode.namedChildren.find((c) => c.type === 'dotted_name')?.text ?? '';
    }
    for (const name of node.childrenForFieldName('name')) {
      const imported =
        name.type === 'aliased_import' ? name.childForFieldName('name')?.text : name.text;
      const local =
        name.type === 'aliased_import' ? name.childForFieldName('alias')?.text : name.text;
      if (imported && local) out.push({ local, module, imported, ...(level ? { level } : {}) });
    }
  }
  return out;
}

export const pythonAdapter: LanguageAdapter = {
  language: 'python',
  extensions: ['.py', '.pyi'],

  extract(tree: Tree, _source: string, _ctx: AdapterContext) {
    const root = tree.rootNode;
    const symbols: RawSymbol[] = [];
    const imports: RawImport[] = [];
    const registrations: RawRegistration[] = [];
    const exports = new Map<string, string>();
    const prefixes = new Map<string, string>();

    // Префиксы роутеров нужны до разбора декораторов.
    for (const stmt of root.namedChildren) {
      const assign = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : null;
      if (assign?.type !== 'assignment') continue;
      const left = assign.childForFieldName('left');
      const right = assign.childForFieldName('right');
      if (left?.type === 'identifier' && right?.type === 'call') {
        const prefix = pythonRouterPrefix(right);
        if (prefix) prefixes.set(left.text, prefix);
      }
    }

    function collectCall(node: Node, owner: RawSymbol | null): void {
      const fnNode = node.childForFieldName('function');
      const callee = memberPath(fnNode);
      const reg = pythonRegistration(node);
      if (reg) registrations.push(reg);
      if (!owner) return;
      const call: RawCall = { callee, line: node.startPosition.row };
      const link = pythonCallLink(node);
      if (link) call.link = link;
      owner.calls.push(call);
    }

    /** Обход с текущим владельцем вызовов. Вложенные функции не становятся символами — их вызовы достаются внешней. */
    function walk(node: Node, owner: RawSymbol | null): void {
      if (node.type === 'decorator') {
        // Вызовы в декораторах — это регистрация обработчика, а не вызовы функции.
        for (const c of node.namedChildren) if (c.type === 'call') walkDecoratorArgs(c);
        return;
      }
      if (node.type === 'call') collectCall(node, owner);
      for (const child of node.namedChildren) walk(child, owner);
    }

    function walkDecoratorArgs(call: Node): void {
      const reg = pythonRegistration(call);
      if (reg) registrations.push(reg);
    }

    function addSymbol(def: Node, kind: RawSymbol['kind'], parentClass?: string): RawSymbol | null {
      const name = def.childForFieldName('name')?.text;
      if (!name) return null;
      const outer = outerNode(def, ['decorated_definition']);
      const sym: RawSymbol = {
        qualified: parentClass ? `${parentClass}.${name}` : name,
        name,
        kind,
        range: rangeOf(outer),
        signature: signatureOf(def),
        body: outer.text,
        calls: [],
      };
      if (parentClass) sym.parentClass = parentClass;
      for (const d of decoratorsOf(def)) {
        const entry = pythonDecoratorEntry(d, prefixes);
        if (entry) {
          sym.entry = entry;
          break;
        }
      }
      symbols.push(sym);
      return sym;
    }

    function unwrap(stmt: Node): Node {
      return stmt.type === 'decorated_definition'
        ? (stmt.childForFieldName('definition') ?? stmt)
        : stmt;
    }

    for (const stmt of root.namedChildren) {
      if (stmt.type === 'import_statement' || stmt.type === 'import_from_statement') {
        imports.push(...parseImports(stmt));
        continue;
      }
      const def = unwrap(stmt);
      if (stmt.type === 'decorated_definition') {
        for (const d of stmt.namedChildren) if (d.type === 'decorator') walk(d, null);
      }

      if (FUNCTION_TYPES.includes(def.type)) {
        const sym = addSymbol(def, 'function');
        if (sym) {
          exports.set(sym.name, sym.qualified);
          for (const c of def.namedChildren) walk(c, sym);
        }
        continue;
      }

      if (CLASS_TYPES.includes(def.type)) {
        const cls = addSymbol(def, 'class');
        if (!cls) continue;
        exports.set(cls.name, cls.qualified);
        const body = def.childForFieldName('body');
        const bases = def.childForFieldName('superclasses');
        if (bases) walk(bases, cls);
        for (const member of body?.namedChildren ?? []) {
          const mdef = unwrap(member);
          if (member.type === 'decorated_definition') {
            for (const d of member.namedChildren) if (d.type === 'decorator') walk(d, null);
          }
          if (FUNCTION_TYPES.includes(mdef.type)) {
            const m = addSymbol(mdef, 'method', cls.name);
            if (m) for (const c of mdef.namedChildren) walk(c, m);
          } else {
            walk(member, cls);
          }
        }
        continue;
      }

      // Переменная верхнего уровня: X = ...
      const assign = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : null;
      const left = assign?.type === 'assignment' ? assign.childForFieldName('left') : null;
      if (assign && left?.type === 'identifier') {
        const right = assign.childForFieldName('right');
        const sym: RawSymbol = {
          qualified: left.text,
          name: left.text,
          kind: 'variable',
          range: rangeOf(stmt),
          signature: left.text,
          body: stmt.text,
          calls: [],
        };
        if (right?.type === 'call') {
          const ctor = memberPath(right.childForFieldName('function'));
          if (ctor.length) sym.instanceOf = ctor;
        }
        symbols.push(sym);
        exports.set(sym.name, sym.qualified);
        walk(assign, sym);
        continue;
      }

      // Прочий код модуля (if __name__ == "__main__": ...): только регистрации обработчиков.
      walk(stmt, null);
    }

    return { symbols, imports, exports, starExports: [], registrations };
  },
};
