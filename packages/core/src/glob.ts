/**
 * Минимальные glob-шаблоны для include/exclude и слоёв: `**`, `*`, `?`, `{a,b}`.
 * Пути всегда posix и относительны корня репо.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**/" — ноль или больше папок; "**" в конце — что угодно
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inGroup = true;
      re += '(?:';
    } else if (ch === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (ch === ',' && inGroup) {
      re += '|';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}

export function matchAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(file, g));
}
