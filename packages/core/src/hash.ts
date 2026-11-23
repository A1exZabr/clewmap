import { createHash } from 'node:crypto';
import type { Language } from './schema.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Нормализует код для bodyHash: убирает комментарии и схлопывает пробельные символы.
 * Строковые литералы не трогаются, поэтому «#» или «//» внутри строки не считаются комментарием.
 * Правка отступов, переносов и комментариев не меняет хэш — описание не пересчитывается.
 */
export function normalizeBody(text: string, language: Language): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  const isPy = language === 'python';

  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];

    // Комментарии
    if (isPy && ch === '#') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (!isPy && ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (!isPy && ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out.push(' ');
      continue;
    }

    // Строки
    if (ch === '"' || ch === "'" || (!isPy && ch === '`')) {
      const triple = isPy && text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (!triple && ch !== '`' && text[j] === '\n') break;
        j++;
      }
      out.push(text.slice(i, j));
      i = j;
      continue;
    }

    // Пробелы
    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(text[i]!)) i++;
      out.push(' ');
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('').replace(/ {2,}/g, ' ').trim();
}
