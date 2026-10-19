#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { openDatabase } from '../store/db.ts';
import { retrieve, type RetrievalResults } from '../retrieval/retrieve.ts';
import { liveForumList } from '../retrieval/live-forum.ts';

const DOCS_EPOCH_DATE = '1970-01-01';

export function formatResults(results: RetrievalResults, { json }: { json: boolean }): string {
  if (json) return JSON.stringify({ bestSimilarity: results.bestSimilarity, results }, null, 2);
  const lines = [`best similarity ${results.bestSimilarity.toFixed(2)}`, ''];
  for (const r of results) {
    const date = r.createdAt.slice(0, 10);
    const role = r.authorRole && r.authorRole !== 'reporter' ? `comment by ${r.authorRole}` : null;
    const meta = [r.outcome?.state, r.outcome?.stateReason, date === DOCS_EPOCH_DATE ? null : date, role].filter(Boolean).join(', ');
    const title = r.heading ? `${r.title} › ${r.heading}` : r.title;
    lines.push(`${r.rank}. [${r.source}] ${title}${meta ? ` (${meta})` : ''}`);
    lines.push(`   ${r.url}`);
    const lexical = r.scores.lexical === null ? 'none' : r.scores.lexical.toFixed(2);
    const similarity = r.scores.itemSimilarity === null ? 'none' : r.scores.itemSimilarity.toFixed(2);
    lines.push(`   similarity ${similarity} · lexical ${lexical} · fused ${r.scores.fused.toFixed(4)}`);
    lines.push(`   ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      index: { type: 'string' },
      k: { type: 'string', default: '8' },
      'as-of': { type: 'string' },
      json: { type: 'boolean', default: false },
      'model-cache': { type: 'string', default: '.model-cache' },
      'live-forum': { type: 'string' },
    },
  });
  const question = positionals.join(' ').trim();
  const k = Number(values.k);
  if (!values.config || !values.index || !question || !Number.isInteger(k) || k <= 0) {
    console.error('usage: query --config <knowledge-bot.yaml> --index <knowledge.sqlite> [--k 8] [--as-of <iso>] [--live-forum <host>/<category-slug>] [--json] "<question>"');
    process.exit(2);
  }
  try {
    const config = loadConfig(values.config);
    const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
    const db = openDatabase(values.index, { readOnly: true });
    try {
      const liveLists = [];
      if (values['live-forum']) {
        const separator = values['live-forum'].indexOf('/');
        if (separator <= 0 || separator === values['live-forum'].length - 1) throw new Error(`--live-forum expects <host>/<category-slug>, got ${values['live-forum']}`);
        const host = values['live-forum'].slice(0, separator);
        const categorySlug = values['live-forum'].slice(separator + 1);
        liveLists.push(await liveForumList(db, { host, categorySlug, question, log: (line) => console.error(line) }));
      }
      const results = await retrieve(db, embedder, question, { k, asOf: values['as-of'], minSimilarity: config.triage?.minSimilarity, liveLists });
      console.log(formatResults(results, { json: values.json }));
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
