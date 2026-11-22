import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, type SupportedLanguage } from './parser.js';

const samples: Record<SupportedLanguage, [string, string]> = {
  python: [
    'async def create_order(message, cart):\n    return calc_total(cart.items)\n',
    'function_definition',
  ],
  typescript: ['export const formatPrice = (v: number): string => v.toFixed(2);', 'arrow_function'],
  tsx: ['export default function B() { return <button onClick={go}>x</button>; }', 'jsx_element'],
  javascript: ['fetch("/api/checkout", { method: "POST" });', 'call_expression'],
};

describe('tree-sitter WASM grammars', () => {
  for (const [language, [source, nodeType]] of Object.entries(samples) as [
    SupportedLanguage,
    [string, string],
  ][]) {
    it(`parses ${language} without errors`, async () => {
      const tree = await parse(source, language);
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType(nodeType).length).toBeGreaterThan(0);
    });
  }
});

describe('fixtures parse cleanly', () => {
  const root = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
  const byExt: Record<string, SupportedLanguage> = {
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
  };
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
    (f) => extname(f) in byExt,
  );

  it('finds fixture sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of files) {
    it(file, async () => {
      const tree = await parse(readFileSync(join(root, file), 'utf8'), byExt[extname(file)]!);
      expect(tree.rootNode.hasError).toBe(false);
    });
  }
});
