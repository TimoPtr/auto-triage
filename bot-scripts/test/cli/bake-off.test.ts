import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeOffMarkdown, type BakeOffRow } from '../../src/eval/bake-off.ts';

test('bakeOffMarkdown renders one row per model and marks skipped ones', () => {
  const rows: BakeOffRow[] = [
    { name: 'bge-small', modelKey: 'Xenova/bge-small-en-v1.5@abc@q8@cls', buildSeconds: 195.5, indexBytes: 91 * 1024 * 1024, chunksPerSecond: 212.3, recallAt5: 71.2, mrr: 0.512, gatePrecision: 80.1, gateSpecificity: 60.5 },
    { name: 'gemma', modelKey: 'onnx-community/embeddinggemma-300m-ONNX@def@q8@mean@q=task: search result | query: ', buildSeconds: 0, indexBytes: 0, chunksPerSecond: 0, recallAt5: 0, mrr: 0, gatePrecision: null, gateSpecificity: null, skipped: 'download failed: 403' },
  ];
  const md = bakeOffMarkdown(rows);
  const lines = md.split('\n').filter((l) => l.startsWith('| '));
  assert.equal(lines.length, 4, md);
  assert.match(lines[2], /^\| bge-small \| `Xenova\/bge-small-en-v1\.5@abc@q8@cls` \| 195\.5 \| 91\.0 \| 212 \| 71\.2 \| 0\.512 \| 80\.1 \| 60\.5 \|  \|$/);
  assert.match(lines[3], /^\| gemma \| `onnx-community\/embeddinggemma-300m-ONNX@def@q8@mean@q=task: search result \\\| query: ` \| - \| - \| - \| - \| - \| - \| - \| skipped: download failed: 403 \|$/, 'a pipe in the key is escaped');
});
