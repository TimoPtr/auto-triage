/** Days between two full rebuilds; everything in between is incremental. */
export const FULL_REBUILD_DAYS = 7;
/** Overlap subtracted from the previous start, so nothing changed during that build is missed. */
export const SINCE_OVERLAP_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BuildMode = 'full' | 'incremental';

export interface BuildPlan {
  mode: BuildMode;
  /** Read window start for an incremental build; null for a full one. */
  since: Date | null;
  reason: string;
  /** When the last full build started: now for a full plan, carried over for an incremental one. */
  fullBuiltAt: string | null;
}

export interface PlanBuildInput {
  /** Meta of a usable previous index, or null when there is none. */
  previousMeta: Record<string, string | undefined> | null;
  configHash: string;
  now: Date;
  full: boolean;
}

/** Why the previous index cannot seed an incremental build, or null when it can. */
function fullReason({ previousMeta, configHash, now, full }: PlanBuildInput): string | null {
  if (full) return 'forced';
  if (!previousMeta) return 'no previous index';
  if (!previousMeta.started_at) return 'previous index has no started_at';
  if (previousMeta.config_hash !== configHash) return `config hash ${previousMeta.config_hash} changed to ${configHash}`;
  if (!previousMeta.full_built_at) return 'previous index has no full_built_at';
  const fullAgeDays = (now.getTime() - Date.parse(previousMeta.full_built_at)) / DAY_MS;
  if (!(fullAgeDays < FULL_REBUILD_DAYS)) return `last full build ${Math.floor(fullAgeDays)} days ago`;
  return null;
}

/** Decides between a full rebuild and an incremental build from the previous index's meta. */
export function planBuild(input: PlanBuildInput): BuildPlan {
  const reason = fullReason(input);
  if (reason) return { mode: 'full', since: null, reason, fullBuiltAt: input.now.toISOString() };
  const since = new Date(Date.parse(input.previousMeta!.started_at!) - SINCE_OVERLAP_MS);
  return { mode: 'incremental', since, reason: `incremental since ${since.toISOString()}`, fullBuiltAt: input.previousMeta!.full_built_at! };
}
