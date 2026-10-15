#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.js';
import { createEmbedder } from '../embed/embedder.js';
import { openDatabase } from '../store/db.js';
import { retrieve } from '../retrieval/retrieve.js';

const DOCS_EPOCH_DATE = '1970-01-01';

/**
 * @param {import('../retrieval/retrieve.js').RetrievalResult[] & { bestSimilarity: number }} results
 * @param {{ json: boolean }} options
 */
export function formatResults(results, { json }) {
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
    const similarity = r.scores.similarity === null ? 'none' : r.scores.similarity.toFixed(2);
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
    },
  });
  const question = positionals.join(' ').trim();
  if (!values.config || !values.index || !question) {
    console.error('usage: query --config <knowledge-bot.yaml> --index <knowledge.sqlite> [--k 8] [--as-of <iso>] [--json] "<question>"');
    process.exit(2);
  }
  const config = loadConfig(values.config);
  const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
  const db = openDatabase(values.index, { readOnly: true });
  try {
    const triage = /** @type {{ minSimilarity?: number } | undefined} */ (config.triage);
    const results = await retrieve(db, embedder, question, { k: Number(values.k), asOf: values['as-of'], minSimilarity: triage?.minSimilarity });
    console.log(formatResults(results, { json: values.json }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    db.close();
  }
}
