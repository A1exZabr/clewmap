import { z } from 'zod';

/**
 * Схема графа .clewmap/. Единственное место, где описан формат.
 * Порядок ключей в объектах z.object задаёт порядок ключей в JSON-файлах:
 * store.ts прогоняет данные через эти схемы перед записью.
 */

export const FORMAT_VERSION = 1 as const;

export const LanguageSchema = z.enum(['python', 'typescript', 'javascript']);
export type Language = z.infer<typeof LanguageSchema>;

/** [строка, колонка], обе с нуля. */
export const PositionSchema = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const SummarySchema = z.object({
  text: z.string(),
  forBodyHash: z.string(),
  stale: z.boolean(),
  model: z.string(),
  createdAt: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;

/** Смысловой блок тела функции. Границы совпадают с операторами tree-sitter. */
export const CodeBlockSchema = z.object({
  range: RangeSchema,
  statements: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  label: z.string(),
  text: z.string().nullable(),
  forBodyHash: z.string(),
});
export type CodeBlock = z.infer<typeof CodeBlockSchema>;

export const EdgeKindSchema = z.enum(['call', 'http', 'event']);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const CallEdgeSchema = z.object({
  target: z.string(),
  line: z.number().int().min(0),
  resolved: z.boolean(),
  kind: EdgeKindSchema,
  via: z.string().optional(),
});
export type CallEdge = z.infer<typeof CallEdgeSchema>;

export const EntryKindSchema = z.enum(['http-route', 'bot-callback', 'bot-command', 'event']);
export type EntryKind = z.infer<typeof EntryKindSchema>;

export const EntrySchema = z.object({
  kind: EntryKindSchema,
  key: z.string(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const SymbolKindSchema = z.enum(['function', 'method', 'class', 'variable']);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolNodeSchema = z.object({
  id: z.string(),
  kind: SymbolKindSchema,
  name: z.string(),
  range: RangeSchema,
  signature: z.string(),
  signatureHash: z.string(),
  bodyHash: z.string(),
  layer: z.string().nullable(),
  entry: EntrySchema.optional(),
  calls: z.array(CallEdgeSchema),
  summary: SummarySchema.nullable(),
  blocks: z.array(CodeBlockSchema).nullable(),
});
export type SymbolNode = z.infer<typeof SymbolNodeSchema>;

export const ModuleFileSchema = z.object({
  file: z.string(),
  language: LanguageSchema,
  fileHash: z.string(),
  layer: z.string().nullable(),
  summary: SummarySchema.nullable(),
  symbols: z.array(SymbolNodeSchema),
});
export type ModuleFile = z.infer<typeof ModuleFileSchema>;

export const ManifestSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  generator: z.string(),
  languages: z.array(LanguageSchema),
  lastCommit: z.string().nullable(),
  updatedAt: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;
