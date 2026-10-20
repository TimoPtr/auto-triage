#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.ts';
import type { Config } from '../config/types.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { openDatabase } from '../store/db.ts';
import { createGitHubClient } from '../providers/github/client.ts';
import { liveForumList } from '../retrieval/live-forum.ts';
import type { RankedList } from '../retrieval/rrf.ts';
import { fetchIssue } from '../triage/issue.ts';
import { prepareTriage } from '../triage/prepare.ts';
import { validateHandoff } from '../triage/handoff.ts';
import { writeOutputs } from './index-status.ts';
import { appendSummary } from './summary.ts';
import type { DatabaseSync } from 'node:sqlite';

const USABLE_STATUSES = new Set(['fresh', 'stale']);

/** The first Discourse host of the config with its first category given as a slug, for the live search. */
export function liveForumTarget(config: Config): { host: string; categorySlug: string } | null {
  for (const [host, site] of Object.entries(config.providers.discourse ?? {})) {
    const slug = site.categories.find((c) => !/^\d+$/.test(c));
    if (slug) return { host, categorySlug: slug };
  }
  return null;
}

function usage(): never {
  console.error('usage: prepare-triage --config <knowledge-bot.yaml> --index <knowledge.sqlite> --index-status <fresh|stale|unusable|missing> --repo <owner/repo> --issue <n> --out <handoff.json> [--model-cache .model-cache] [--no-live-forum]\n  needs GH_TOKEN or GITHUB_TOKEN');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' }, index: { type: 'string' }, 'index-status': { type: 'string' }, repo: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' },
      'model-cache': { type: 'string', default: process.env.KB_MODEL_CACHE || '.model-cache' }, 'no-live-forum': { type: 'boolean', default: false },
    },
  });
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const issueNumber = Number(values.issue);
  if (!values.config || !values.index || !values['index-status'] || !values.repo || !values.out || !token || !Number.isInteger(issueNumber) || issueNumber <= 0) usage();
  const log = (line: string) => console.error(line);
  let db: DatabaseSync | null = null;
  try {
    const config = loadConfig(values.config);
    const client = createGitHubClient({ token, baseUrl: process.env.GITHUB_API_URL || undefined, log });
    const issue = await fetchIssue(client, values.repo, issueNumber);
    const usable = USABLE_STATUSES.has(values['index-status']);
    db = usable ? openDatabase(values.index, { readOnly: true }) : null;
    const embedder = usable ? createEmbedder(config.embedding, { cacheDir: values['model-cache'] }) : null;
    const liveLists: RankedList[] = [];
    const target = values['no-live-forum'] ? null : liveForumTarget(config);
    if (db && target) liveLists.push(await liveForumList(db, { ...target, question: `${issue.title}\n${issue.body}`, log }));
    const { decision, handoff } = await prepareTriage({ config, db, embedder, issue, repository: values.repo, liveLists });
    if (handoff) {
      mkdirSync(dirname(values.out), { recursive: true });
      writeFileSync(values.out, JSON.stringify(validateHandoff(handoff), null, 2));
    }
    console.log(JSON.stringify(decision));
    writeOutputs({ 'should-continue': decision.shouldContinue, reason: decision.reason, 'best-similarity': decision.bestSimilarity.toFixed(2) });
    appendSummary([`triage #${issue.number}: index ${values['index-status']}, gate ${decision.reason}, best similarity ${decision.bestSimilarity.toFixed(2)}${handoff ? `, ${handoff.excerpts.length} excerpts` : ''}`]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    db?.close();
  }
}
