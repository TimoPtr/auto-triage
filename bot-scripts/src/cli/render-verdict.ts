#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.ts';
import { readHandoff, HandoffError } from '../triage/handoff.ts';
import { readAgentOutput, parseVerdict, tierOf, demote, VerdictError } from '../triage/verdict.ts';
import { renderComment } from '../triage/render.ts';
import { triageSettings } from '../triage/settings.ts';
import { writeOutputs } from './index-status.ts';
import { appendSummary } from './summary.ts';

function usage(): never {
  console.error('usage: render-verdict --config <knowledge-bot.yaml> --handoff <handoff.json> --agent-output <agent_output.json> --out-dir <dir> --run-id <id>');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, handoff: { type: 'string' }, 'agent-output': { type: 'string' }, 'out-dir': { type: 'string' }, 'run-id': { type: 'string' } } });
  if (!values.config || !values.handoff || !values['agent-output'] || !values['out-dir'] || !values['run-id']) usage();
  try {
    const { staged } = triageSettings(loadConfig(values.config));
    const handoff = readHandoff(values.handoff);
    const verdict = parseVerdict(readAgentOutput(values['agent-output']), handoff);
    const rawTier = tierOf(verdict.confidence, handoff.thresholds);
    const demotion = handoff.retrieval.demote;
    const tier = demotion ? demote(rawTier) : rawTier;
    const comment = renderComment({ handoff, verdict, tier, runId: values['run-id'] });
    const post = comment !== null && !staged;
    mkdirSync(values['out-dir'], { recursive: true });
    const commentPath = join(values['out-dir'], 'comment.md');
    if (comment !== null) writeFileSync(commentPath, comment);
    writeFileSync(join(values['out-dir'], 'verdict.json'), JSON.stringify({ confidence: verdict.confidence, tier, duplicates: verdict.duplicates, related: verdict.related, component: verdict.component, notes: verdict.notes, staged, posted: post, demoted: demotion !== null, demotedFrom: demotion ? rawTier : null }, null, 2));
    writeOutputs({ tier, post, 'comment-path': comment !== null ? commentPath : '' });
    appendSummary([
      `### Triage verdict for #${handoff.issue.number}`, '',
      `- tier: ${tier} (confidence ${verdict.confidence}, answer from ${handoff.thresholds.answer}, links from ${handoff.thresholds.links})`,
      `- duplicates: ${verdict.duplicates.join(', ') || 'none'}; related: ${verdict.related.join(', ') || 'none'}`,
      `- component: ${verdict.component ?? 'unknown'}`,
      ...(demotion ? [`- demoted from ${rawTier}: resembles suppressed issue #${demotion.issue} (similarity ${demotion.similarity.toFixed(2)})`] : []),
      ...verdict.notes.map((n) => `- note: ${n}`),
      ...(comment === null ? ['', 'no comment for this tier'] : [...(staged ? ['', 'staged: the comment below was not posted'] : []), '', '````markdown', comment.trimEnd(), '````']),
    ]);
    console.log(JSON.stringify({ tier, post, confidence: verdict.confidence }));
  } catch (error) {
    const prefix = error instanceof VerdictError || error instanceof HandoffError ? `${error.name}: ` : '';
    const message = `${prefix}${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    appendSummary(['### Triage verdict', '', `no comment posted: ${message}`]);
    process.exit(1);
  }
}
