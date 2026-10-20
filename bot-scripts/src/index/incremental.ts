import { copyFileSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../store/db.ts';
import { statements, type WriteStats } from '../store/writer.ts';
import { assertSameModel, finish, removeAbsent, removeFrom, upsertInto } from '../store/upsert.ts';
import { concat } from './stream.ts';
import { isRemoval, type Provider, type SourceKind } from '../providers/types.ts';
import type { Embedder } from '../embed/embedder.ts';

/** Sources read from a checkout: always complete, so an item missing from the pass is gone. */
const CHECKOUT_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>(['docs', 'code', 'file']);

export interface IncrementalBuildInput {
  previousPath: string;
  outPath: string;
  providers: Provider[];
  since: Date;
  embedder: Embedder;
  /** Meta entries to write; `started_at` and `full_built_at` come from the build plan. */
  meta: Record<string, string>;
  log?: (line: string) => void;
}

type Scope = { provider: string; origin: string; source: SourceKind };
const scopeKey = (s: Scope) => `${s.provider}\u0000${s.origin}\u0000${s.source}`;

/** Upserts and removes the stream into the open index; returns the checkout scopes seen with their present ids. */
async function applyStream(db: DatabaseSync, input: IncrementalBuildInput, stats: WriteStats, log: (line: string) => void): Promise<Map<string, { scope: Scope; present: Set<string> }>> {
  const stmt = statements(db);
  const seen = new Map<string, { scope: Scope; present: Set<string> }>();
  for await (const item of concat(input.providers, log, { since: input.since })) {
    if (isRemoval(item)) {
      if (removeFrom(db, item)) log(`removed ${item.source} ${item.origin}#${item.sourceId}`);
      continue;
    }
    await upsertInto(db, stmt, item, input.embedder, stats);
    if (!CHECKOUT_SOURCES.has(item.source)) continue;
    const scope = { provider: item.provider, origin: item.origin, source: item.source };
    const entry = seen.get(scopeKey(scope)) ?? { scope, present: new Set<string>() };
    entry.present.add(item.sourceId);
    seen.set(scopeKey(scope), entry);
  }
  return seen;
}

/**
 * Builds the index from a copy of the previous one: only what the providers
 * report changed since the window start is upserted or removed, checkout
 * sources are pruned to what the pass saw, then the FTS table, counts and
 * meta are rewritten. The previous file is never written; a failure removes
 * the copy and rethrows.
 */
export async function incrementalBuild(input: IncrementalBuildInput): Promise<WriteStats> {
  const { previousPath, outPath, embedder, meta, log = () => {} } = input;
  const tmpPath = `${outPath}.tmp`;
  rmSync(tmpPath, { force: true });
  copyFileSync(previousPath, tmpPath);
  const db = openDatabase(tmpPath);
  const stats: WriteStats = { items: 0, chunks: 0, embedded: 0, reused: 0 };
  try {
    assertSameModel(db, embedder);
    const seen = await applyStream(db, input, stats, log);
    for (const { scope, present } of seen.values()) {
      const gone = removeAbsent(db, scope, present);
      if (gone) log(`${scope.source} ${scope.origin}: ${gone} items no longer in the checkout`);
    }
    finish(db);
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({ ...meta, built_at: new Date().toISOString() })) put.run(key, value);
    db.exec('VACUUM');
    db.close();
    renameSync(tmpPath, outPath);
    log(`index updated: ${stats.items} items changed, ${stats.embedded} chunks embedded, ${stats.reused} reused`);
    return stats;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
