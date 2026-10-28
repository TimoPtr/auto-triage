import { readIssue } from '../providers/github/issues.ts';
import { readPull } from '../providers/github/pulls.ts';
import { upsertItems, removeItem } from '../store/upsert.ts';
import type { WriteStats } from '../store/writer.ts';
import type { Config } from '../config/types.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { IndexItem, PaginatingClient } from '../providers/types.ts';
import type { RawStore } from '../store/raw.ts';

export type ItemKind = 'issue' | 'pull';
export interface ItemRefText { kind: ItemKind; number: number }

const ITEM_REF = /^(issue|pull):(\d+)$/;

/** Parses `issue:<n>` or `pull:<n>`. */
export function parseItemRef(text: string): ItemRefText {
  const match = ITEM_REF.exec(text.trim());
  if (!match) throw new Error(`item must be issue:<n> or pull:<n>, got ${text}`);
  return { kind: match[1] as ItemKind, number: Number(match[2]) };
}

export interface AppendInput {
  config: Config;
  repo: string;
  ref: ItemRefText;
  indexPath: string;
  embedder: Embedder;
  client: PaginatingClient;
  raw?: RawStore;
  now?: Date;
  log?: (line: string) => void;
}
export type AppendAction = 'upserted' | 'removed' | 'skipped';
/** `changed` is false when nothing in the index moved (a skip, or a removal of an item that was not there). */
export interface AppendResult { action: AppendAction; changed: boolean; reason?: string; stats?: WriteStats }

/** Reads one item from the API with the section of the config that governs its kind, or null when it no longer qualifies. */
async function readOne({ config, repo, ref, client, raw, now, log }: AppendInput): Promise<IndexItem | null | 'unconfigured'> {
  const repoConfig = config.providers.github?.[repo];
  if (ref.kind === 'issue') {
    if (!repoConfig?.issues) return 'unconfigured';
    return readIssue({ client, repo, number: ref.number, options: repoConfig.issues, raw });
  }
  if (!repoConfig?.pulls) return 'unconfigured';
  return readPull({ client, repo, number: ref.number, options: repoConfig.pulls, now, raw, log });
}

/** Reads one closed item and replaces it in the index, or removes it when it no longer qualifies. */
export async function appendItem(input: AppendInput): Promise<AppendResult> {
  const { repo, ref, indexPath, embedder, log = () => {} } = input;
  const item = await readOne(input);
  if (item === 'unconfigured') return { action: 'skipped', changed: false, reason: `${repo} has no ${ref.kind === 'issue' ? 'issues' : 'pulls'} section in the config` };
  if (!item) {
    const removed = removeItem({ indexPath, ref: { provider: 'github', origin: repo, source: ref.kind, sourceId: String(ref.number) } });
    return { action: 'removed', changed: removed, reason: removed ? 'no longer qualifies' : 'not in the index and does not qualify' };
  }
  async function* one() { yield item as IndexItem; }
  const stats = await upsertItems({ indexPath, items: one(), embedder, log });
  return { action: 'upserted', changed: true, stats };
}
