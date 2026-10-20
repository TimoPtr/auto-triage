import { existsSync } from 'node:fs';
import { openDatabase, readMeta, FORMAT_VERSION, SCHEMA_VERSION } from '../store/db.ts';
import { RAW_SCHEMA_VERSION } from '../store/raw.ts';
import { modelKeyOf } from '../embed/embedder.ts';
import type { Config } from '../config/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Age in days under which an index counts as fresh by default. */
export const DEFAULT_FRESH_DAYS = 2;

export type IndexHealth = 'fresh' | 'stale' | 'unusable' | 'missing';

export interface IndexStatus {
  found: boolean;
  usable: boolean;
  /** What blocks serving the index, or null when it is usable. */
  reason: string | null;
  status: IndexHealth;
  builtAt: string | null;
  ageDays: number | null;
  /** When the last full build started; null for an index built before incremental builds existed. */
  fullBuiltAt: string | null;
  fullAgeDays: number | null;
  items: number;
  chunks: number;
  formatVersion: number;
  schemaVersion: number;
}

export interface IndexStatusInput { indexPath: string; config: Config; now?: Date; freshDays?: number }

export interface Versions { formatVersion: number; schemaVersion: number; rawSchemaVersion: number }

const missing = (): IndexStatus => ({
  found: false, usable: false, reason: 'no index file', status: 'missing', builtAt: null, ageDays: null, fullBuiltAt: null, fullAgeDays: null,
  items: 0, chunks: 0, formatVersion: FORMAT_VERSION, schemaVersion: SCHEMA_VERSION,
});
const unusable = (reason: string): IndexStatus => ({ ...missing(), found: true, reason, status: 'unusable' });

/** The versions a cache key or a consumer needs without opening an index. */
export function rawVersions(): Versions {
  return { formatVersion: FORMAT_VERSION, schemaVersion: SCHEMA_VERSION, rawSchemaVersion: RAW_SCHEMA_VERSION };
}

/** What blocks serving an index with this config, or null. */
function blocker(meta: Record<string, string>, config: Config): string | null {
  if (meta.schema_version !== String(SCHEMA_VERSION)) return `schema ${meta.schema_version} != ${SCHEMA_VERSION}`;
  if (meta.format_version !== String(FORMAT_VERSION)) return `format ${meta.format_version} != ${FORMAT_VERSION}`;
  const wanted = modelKeyOf(config.embedding);
  if (meta.model_key !== wanted) return `model ${meta.model_key} != ${wanted}`;
  if (meta.dimensions !== String(config.embedding.dimensions)) return `dimensions ${meta.dimensions} != ${config.embedding.dimensions}`;
  return null;
}

/** The meta table of an index file, or null with the reason when it cannot be read. */
function metaOf(indexPath: string): { meta: Record<string, string> } | { error: string } {
  try {
    const db = openDatabase(indexPath, { readOnly: true });
    try {
      return { meta: readMeta(db) };
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Reads an index file's meta and says whether this config can serve it and how old it is. Never throws on a bad file. */
export function indexStatus({ indexPath, config, now = new Date(), freshDays = DEFAULT_FRESH_DAYS }: IndexStatusInput): IndexStatus {
  if (!existsSync(indexPath)) return missing();
  const read = metaOf(indexPath);
  if ('error' in read) return unusable(`cannot open: ${read.error}`);
  const { meta } = read;
  const reason = blocker(meta, config);
  const builtAt = meta.built_at ?? null;
  const fullBuiltAt = meta.full_built_at || null;
  const age = (iso: string | null) => (iso ? (now.getTime() - Date.parse(iso)) / DAY_MS : null);
  const ageDays = age(builtAt);
  const base = {
    found: true, builtAt, ageDays, fullBuiltAt, fullAgeDays: age(fullBuiltAt), items: Number(meta.item_count ?? 0), chunks: Number(meta.chunk_count ?? 0),
    formatVersion: Number(meta.format_version ?? FORMAT_VERSION), schemaVersion: Number(meta.schema_version ?? SCHEMA_VERSION),
  };
  if (reason) return { ...base, usable: false, reason, status: 'unusable' };
  const fresh = ageDays !== null && ageDays < freshDays;
  return { ...base, usable: true, reason: null, status: fresh ? 'fresh' : 'stale' };
}
