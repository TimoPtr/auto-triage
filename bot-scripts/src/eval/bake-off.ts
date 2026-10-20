/** One candidate model's build and eval figures; `skipped` carries the reason when it produced none. */
export interface BakeOffRow {
  name: string;
  modelKey: string;
  buildSeconds: number;
  indexBytes: number;
  chunksPerSecond: number;
  recallAt5: number;
  mrr: number;
  gatePrecision: number | null;
  gateSpecificity: number | null;
  skipped?: string;
}

const MB = 1024 * 1024;
const pct = (n: number | null) => (n === null ? 'n/a' : n.toFixed(1));

function row(r: BakeOffRow): string {
  const key = `\`${r.modelKey.replaceAll('|', '\\|')}\``;
  if (r.skipped) return `| ${r.name} | ${key} | - | - | - | - | - | - | - | skipped: ${r.skipped} |`;
  return `| ${r.name} | ${key} | ${r.buildSeconds.toFixed(1)} | ${(r.indexBytes / MB).toFixed(1)} | ${Math.round(r.chunksPerSecond)} | ${r.recallAt5.toFixed(1)} | ${r.mrr.toFixed(3)} | ${pct(r.gatePrecision)} | ${pct(r.gateSpecificity)} |  |`;
}

/** The bake-off table: one line per candidate model. */
export function bakeOffMarkdown(rows: BakeOffRow[]): string {
  return [
    '| model | key | build s | index MB | chunks/s | recall@5 | MRR | gate precision | gate specificity | note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row),
    '',
  ].join('\n');
}
