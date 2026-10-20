import { mulberry32 } from './random.ts';
import type { Relation, Split } from './cases.ts';

/** A hit counts when an expected item sits within this rank. */
export const RECALL_K = 5;
/** Ranked entries kept per case; the reciprocal rank is 0 beyond it. */
export const RETRIEVE_K = 10;
/** A recall drop larger than this, with the bootstrap interval excluding zero, is a regression. */
export const REGRESSION_POINTS = 5;
export const BOOTSTRAP_RESAMPLES = 1000;
export const GATE_SWEEP = { from: 0.3, to: 0.95, step: 0.05 };

export interface RankedEntry { source: string; sourceId: string; url: string; fused: number; similarity: number | null }

/** One scored case: where the first expected item ranked, and what the gate saw. */
export interface CaseResult {
  id: string;
  relation: Relation;
  split: Split;
  expectedSources: string[];
  ranked: RankedEntry[];
  firstRank: number | null;
  bestSimilarity: number;
  /** False for a negative case, which expects nothing. */
  positive: boolean;
}

export interface RetrievalMetrics { n: number; recallAt5: number; mrr: number }
export interface GateMetrics { threshold: number; precision: number | null; specificity: number | null; sensitivity: number | null; positives: number; negatives: number }
export interface Comparison { n: number; deltaRecallAt5: number; ci95: [number, number]; regression: boolean }

const points = (count: number, total: number): number => (total === 0 ? 0 : (100 * count) / total);
const ratio = (count: number, total: number): number | null => (total === 0 ? null : (100 * count) / total);
const hit = (r: CaseResult): boolean => r.firstRank !== null && r.firstRank <= RECALL_K;

/** Recall at 5 in points and mean reciprocal rank over the positive cases. */
export function retrievalMetrics(results: CaseResult[]): RetrievalMetrics {
  const positives = results.filter((r) => r.positive);
  const hits = positives.filter(hit).length;
  const rr = positives.reduce((sum, r) => sum + (r.firstRank !== null && r.firstRank <= RETRIEVE_K ? 1 / r.firstRank : 0), 0);
  return { n: positives.length, recallAt5: points(hits, positives.length), mrr: positives.length ? rr / positives.length : 0 };
}

/** Metrics per group; a result belongs to every group its key function names. */
export function byGroup(results: CaseResult[], key: (r: CaseResult) => string[]): Record<string, RetrievalMetrics> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) for (const name of key(r)) {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(r);
  }
  return Object.fromEntries(Array.from(groups, ([name, members]) => [name, retrievalMetrics(members)]));
}

/** The "should comment" gate at a similarity threshold: precision over commented cases, specificity over negatives, sensitivity over positives. */
export function gateAt(results: CaseResult[], threshold: number): GateMetrics {
  const positives = results.filter((r) => r.positive);
  const negatives = results.filter((r) => !r.positive);
  const commented = (r: CaseResult) => r.bestSimilarity >= threshold;
  const truePositives = positives.filter(commented).length;
  const falsePositives = negatives.filter(commented).length;
  return {
    threshold,
    precision: ratio(truePositives, truePositives + falsePositives),
    specificity: ratio(negatives.length - falsePositives, negatives.length),
    sensitivity: ratio(truePositives, positives.length),
    positives: positives.length,
    negatives: negatives.length,
  };
}

export function gateSweep(results: CaseResult[]): GateMetrics[] {
  const steps = Math.round((GATE_SWEEP.to - GATE_SWEEP.from) / GATE_SWEEP.step) + 1;
  return Array.from({ length: steps }, (_, i) => gateAt(results, Number((GATE_SWEEP.from + i * GATE_SWEEP.step).toFixed(2))));
}

/**
 * Paired comparison of two runs on the positive cases both scored: the recall
 * at 5 difference of B minus A in points, with a percentile bootstrap interval.
 */
export function compareRuns(a: CaseResult[], b: CaseResult[], { resamples = BOOTSTRAP_RESAMPLES, seed = 1 } = {}): Comparison {
  const inB = new Map(b.filter((r) => r.positive).map((r) => [r.id, r]));
  const pairs = a.filter((r) => r.positive && inB.has(r.id)).map((r) => (hit(inB.get(r.id)!) ? 1 : 0) - (hit(r) ? 1 : 0));
  const n = pairs.length;
  const mean = (xs: number[]) => (xs.length ? (100 * xs.reduce((s, x) => s + x, 0)) / xs.length : 0);
  const delta = mean(pairs);
  const random = mulberry32(seed);
  const deltas: number[] = [];
  for (let i = 0; i < resamples && n > 0; i += 1) deltas.push(mean(Array.from({ length: n }, () => pairs[Math.floor(random() * n)])));
  deltas.sort((x, y) => x - y);
  const at = (q: number) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))] : 0);
  const ci95: [number, number] = [at(0.025), at(0.975)];
  return { n, deltaRecallAt5: delta, ci95, regression: delta < -REGRESSION_POINTS && ci95[1] < 0 };
}
