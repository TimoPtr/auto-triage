import type { Config } from '../config/types.ts';

/** Parses repeated `--checkout owner/repo=<dir>` values. */
export function parseCheckouts(pairs: string[]): Record<string, string> {
  return Object.fromEntries(pairs.map((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0 || separator === pair.length - 1) throw new Error(`--checkout expects owner/repo=<dir>, got ${pair}`);
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

/** `--self` is the consumer's own checkout: every repository that reads code or files from a checkout and has no explicit one uses it. */
export function withSelf(config: Config, checkouts: Record<string, string>, self: string | undefined): Record<string, string> {
  const out = { ...checkouts };
  if (!self) return out;
  for (const [repo, repoConfig] of Object.entries(config.providers.github ?? {})) {
    if ((repoConfig.code || repoConfig.files?.length) && !out[repo]) out[repo] = self;
  }
  return out;
}
