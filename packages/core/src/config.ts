import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE } from './paths.js';

export const LayerSchema = z.object({
  label: z.string(),
  color: z.string(),
  globs: z.array(z.string()).default([]),
});
export type Layer = z.infer<typeof LayerSchema>;

export const ConfigSchema = z.object({
  include: z.array(z.string()).default(['**']),
  exclude: z.array(z.string()).default([]),
  layers: z.record(z.string(), LayerSchema).default({}),
  links: z
    .object({
      /** Общий префикс API, если фронт ходит на "/api/x", а маршрут объявлен как "/x" (или наоборот). */
      apiPrefix: z.string().nullable().default(null),
      /** Обёртки над HTTP-клиентом вида api.post('/x'): имена объектов. */
      httpClients: z.array(z.string()).default([]),
    })
    .prefault({}),
  summaries: z
    .object({
      provider: z.string().default('claude-cli'),
      model: z.string().nullable().default(null),
      language: z.string().default('ru'),
      batchSize: z.number().int().positive().default(20),
      blocksMinLines: z.number().int().positive().default(8),
    })
    .prefault({}),
  hooks: z
    .object({
      preCommit: z.boolean().default(true),
      postCommit: z.boolean().default(true),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Цвета и подписи стандартных слоёв (как в макете). */
export const DEFAULT_LAYERS: Record<string, { label: string; color: string }> = {
  handler: { label: 'Обработчик', color: '#5AA9F5' },
  service: { label: 'Сервис', color: '#F2A65A' },
  data: { label: 'Данные', color: '#6FD69A' },
  external: { label: 'Внешний API', color: '#E58AD8' },
};

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw ?? {});
}

/** Читает clewmap.config.json; если файла нет, возвращает конфиг по умолчанию. */
export async function readConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path.join(root, CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
    throw e;
  }
  return parseConfig(JSON.parse(text));
}
