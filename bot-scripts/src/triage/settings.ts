import { ConfigError } from '../config/load.ts';
import type { Config } from '../config/types.ts';

export const DEFAULT_MIN_SIMILARITY = 0.35;
export const DEFAULT_ANSWER_CONFIDENCE = 75;
export const DEFAULT_LINKS_CONFIDENCE = 45;
export const DEFAULT_RECHECK_LABEL = 'ai-recheck';

export interface TriageSettings {
  minSimilarity: number;
  /** Confidence from which the comment carries an answer. */
  answer: number;
  /** Confidence from which the comment carries links. */
  links: number;
  recheckLabel: string;
  /** The comment goes to the run summary, never to the issue. */
  staged: boolean;
}

/** The triage settings of a config with the defaults applied. */
export function triageSettings(config: Config): TriageSettings {
  const triage = config.triage ?? {};
  const settings: TriageSettings = {
    minSimilarity: triage.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
    answer: triage.confidence?.answer ?? DEFAULT_ANSWER_CONFIDENCE,
    links: triage.confidence?.links ?? DEFAULT_LINKS_CONFIDENCE,
    recheckLabel: triage.recheckLabel ?? DEFAULT_RECHECK_LABEL,
    staged: triage.staged ?? false,
  };
  if (settings.links > settings.answer) throw new ConfigError('triage.confidence.links must not exceed triage.confidence.answer');
  return settings;
}
