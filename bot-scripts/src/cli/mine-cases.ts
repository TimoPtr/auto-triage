#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/load.ts';
import { openRawStore } from '../store/raw.ts';
import { createGitHubClient } from '../providers/github/client.ts';
import { fetchLinks, type LinkRef } from '../eval/github-links.ts';
import { mineCases, sampleMarkdown, DEFAULT_SAMPLE } from '../eval/mine.ts';
import type { EvalCase } from '../eval/cases.ts';
import type { StoredIssue } from '../providers/github/issues.ts';
import type { StoredPull } from '../providers/github/pulls.ts';
import type { RawStore } from '../store/raw.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    raw: { type: 'string' },
    out: { type: 'string' },
    github: { type: 'boolean', default: false },
    salt: { type: 'string', default: '' },
    sample: { type: 'string', default: String(DEFAULT_SAMPLE) },
  },
});
const sample = Number(values.sample);
if (!values.config || !values.raw || !values.out || !Number.isInteger(sample) || sample < 0) {
  console.error('usage: mine-cases --config <knowledge-bot.yaml> --raw <sqlite> --out <dir> [--github] [--salt <s>] [--sample 30]');
  console.error('--github fetches the duplicate marks and closing references through GraphQL first (GITHUB_TOKEN)');
  process.exit(2);
}

/** Every closed issue and merged pull request of a repository, as link refs keyed by their change marker. */
function refsOf(raw: RawStore, repo: string): LinkRef[] {
  const refs: LinkRef[] = [];
  for (const r of raw.each<StoredIssue>('github', repo, 'issue')) if (r.payload.issue.state === 'closed') refs.push({ kind: 'issue', number: r.payload.issue.number, updatedAt: r.payload.issue.updated_at });
  for (const r of raw.each<StoredPull>('github', repo, 'pull')) if (r.payload.pull.merged_at) refs.push({ kind: 'pull', number: r.payload.pull.number, updatedAt: r.payload.pull.updated_at });
  return refs;
}

function urlsOf(c: EvalCase): { query: string; expected: string[] } {
  const q = c.query as { number: number; origin?: string };
  return {
    query: `https://github.com/${q.origin}/issues/${q.number}`,
    expected: c.expected.map((e) => e.url ?? (e.type === 'forum' ? `https://${e.origin}/t/${e.number}` : `https://github.com/${e.origin}/${e.type === 'pull' ? 'pull' : 'issues'}/${e.number}`)),
  };
}

const config = loadConfig(values.config);
const raw = openRawStore(values.raw);
const log = (line: string) => console.error(line);
try {
  if (values.github) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is required with --github');
    const client = createGitHubClient({ token, log });
    for (const repo of Object.keys(config.providers.github ?? {}).filter((r) => config.providers.github![r].issues)) {
      const stats = await fetchLinks(client, repo, refsOf(raw, repo), raw, log);
      log(`links for ${repo}: ${stats.fetched} fetched, ${stats.reused} reused, ${stats.requests} requests`);
    }
  }
  const { cases, report } = mineCases({ config, raw, salt: values.salt });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'cases.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : ''));
  writeFileSync(join(values.out, 'sample.md'), sampleMarkdown(cases, sample, values.salt, urlsOf));
  writeFileSync(join(values.out, 'mining-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  raw.close();
}
