import { appendFileSync } from 'node:fs';

/** Appends lines to the GitHub Actions job summary when one is configured; a no-op otherwise. */
export function appendSummary(lines: string[], file = process.env.GITHUB_STEP_SUMMARY): void {
  if (!file || lines.length === 0) return;
  appendFileSync(file, `${lines.join('\n')}\n`);
}
