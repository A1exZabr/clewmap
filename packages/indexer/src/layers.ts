import { matchAny, type Config } from '@clewmap/core';

/** Папка → слой, если в конфиге нет подходящего правила. */
const HEURISTICS: [RegExp, string][] = [
  [/^(handlers?|routes?|routers?|controllers?|bot|endpoints?)$/, 'handler'],
  [/^(services?|domain|usecases?|use-cases|logic)$/, 'service'],
  [/^(db|database|repos?|repositor(y|ies)|models?|dao|storage|persistence)$/, 'data'],
];

/** Внешние SDK: вызов любого из них делает символ слоем external (как create_link в макете). */
const EXTERNAL_SDKS = new Set([
  // python
  'requests',
  'httpx',
  'aiohttp',
  'urllib',
  'urllib3',
  'boto3',
  'botocore',
  'stripe',
  'yookassa',
  'openai',
  'anthropic',
  'smtplib',
  'paramiko',
  'grpc',
  'redis',
  'telebot',
  // js
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'axios',
  'node-fetch',
  'got',
  'ky',
  'undici',
  '@anthropic-ai/sdk',
  'nodemailer',
  'twilio',
  'ioredis',
]);

/** Слой файла: первое подходящее правило из конфига, иначе эвристика по папкам. */
export function layerForFile(file: string, config: Config): string | null {
  for (const [name, layer] of Object.entries(config.layers)) {
    if (layer.globs.length && matchAny(file, layer.globs)) return name;
  }
  const dirs = file.split('/').slice(0, -1).reverse();
  for (const dir of dirs) {
    const layer = layerForDir(dir);
    if (layer) return layer;
  }
  return null;
}

/** Слой по имени папки (эвристика): "handlers" → handler, "services" → service, "db" → data. */
export function layerForDir(dir: string): string | null {
  for (const [re, layer] of HEURISTICS) if (re.test(dir.toLowerCase())) return layer;
  return null;
}

/** Ведёт ли внешняя цель (`external:httpx.AsyncClient`) во внешний SDK. */
export function isExternalSdk(target: string): boolean {
  if (!target.startsWith('external:')) return false;
  const name = target.slice('external:'.length);
  if (EXTERNAL_SDKS.has(name)) return true;
  for (const sdk of EXTERNAL_SDKS) {
    if (name.startsWith(`${sdk}.`) || name.startsWith(`${sdk}/`)) return true;
  }
  return /^@aws-sdk\/|^@stripe\/|^stripe\b/.test(name);
}
