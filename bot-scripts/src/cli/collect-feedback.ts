#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.ts';
import { openRawStore } from '../store/raw.ts';
import { createGitHubClient } from '../providers/github/client.ts';
import { collectFeedback } from '../feedback/collect.ts';
import { refreshReactions, FEEDBACK_WINDOW_DAYS } from '../feedback/refresh.ts';
import { digestMarkdown } from '../feedback/digest.ts';
import { writeOutputs } from './index-status.ts';
import { appendSummary } from './summary.ts';

function usage(): never {
  console.error('usage: collect-feedback --config <knowledge-bot.yaml> --raw <raw.sqlite> --repo <owner/repo> --out <dir> [--github] [--window-days 90]\n  --github refreshes reactions and needs GH_TOKEN or GITHUB_TOKEN');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, raw: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, github: { type: 'boolean', default: false }, 'window-days': { type: 'string', default: String(FEEDBACK_WINDOW_DAYS) } },
  });
  const windowDays = Number(values['window-days']);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!values.config || !values.raw || !values.repo || !values.out || !(windowDays > 0) || (values.github && !token)) usage();
  const log = (line: string) => console.error(line);
  try {
    loadConfig(values.config);
    if (!existsSync(values.raw)) {
      console.log('no raw store, no feedback');
      writeOutputs({ comments: 0, suppressed: 0, digest: false });
    } else {
      const raw = openRawStore(values.raw, { log });
      let feedback;
      try { feedback = collectFeedback({ raw, repository: values.repo }); } finally { raw.close(); }
      let refreshed = 0;
      if (values.github) ({ refreshed } = await refreshReactions(createGitHubClient({ token: token as string, log }), feedback, { windowDays, log }));
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, 'feedback.json'), JSON.stringify(feedback, null, 2));
      const digest = feedback.comments.length > 0;
      if (digest) writeFileSync(join(values.out, 'digest.md'), digestMarkdown(feedback));
      console.log(JSON.stringify({ comments: feedback.comments.length, suppressed: feedback.suppressed.length, refreshed }));
      writeOutputs({ comments: feedback.comments.length, suppressed: feedback.suppressed.length, digest });
      appendSummary([`feedback: ${feedback.comments.length} bot comment${feedback.comments.length === 1 ? '' : 's'}, ${feedback.suppressed.length} suppressed issue${feedback.suppressed.length === 1 ? '' : 's'}, ${refreshed} reaction count${refreshed === 1 ? '' : 's'} refreshed`]);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
