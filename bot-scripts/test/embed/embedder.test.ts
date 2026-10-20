import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder, modelKeyOf } from '../../src/embed/embedder.ts';
import type { EmbeddingConfig } from '../../src/config/types.ts';

const config: EmbeddingConfig = { model: 'fake/model', revision: 'abc', dtype: 'q8', dimensions: 3, pooling: 'cls' };

/** A fake extractor returning one-hot vectors by text length, batched like transformers.js. */
function fakeFactory(calls) {
  return async (task, model, options) => {
    calls.push({ task, model, options });
    return async (texts, runOptions) => {
      calls.push({ texts, runOptions });
      const rows = texts.map((t) => [t.length % 3 === 0 ? 1 : 0, t.length % 3 === 1 ? 1 : 0, t.length % 3 === 2 ? 1 : 0]);
      return { dims: [texts.length, 3], tolist: () => rows };
    };
  };
}

test('loads the pipeline once with the pinned model, revision and dtype', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls), cacheDir: '/tmp/x' });
  await embedder.embed(['a']);
  await embedder.embed(['bb']);
  const loads = calls.filter((c) => c.task);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0], { task: 'feature-extraction', model: 'fake/model', options: { revision: 'abc', dtype: 'q8', cache_dir: '/tmp/x' } });
  assert.equal(embedder.modelKey, 'fake/model@abc@q8@cls');
});

test('returns vectors in input order and uses the configured pooling', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls), batchSize: 2 });
  const out = await embedder.embed(['a', 'bb', 'ccc']);
  assert.deepEqual(out.map((v) => Array.from(v)), [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
  const run = calls.find((c) => c.texts);
  assert.deepEqual(run.runOptions, { pooling: 'cls', normalize: true });
});

test('rejects a vector of the wrong dimension', async () => {
  const bad = async () => async (texts) => ({ dims: [texts.length, 2], tolist: () => texts.map(() => [1, 0]) });
  const embedder = createEmbedder(config, { pipelineFactory: bad });
  await assert.rejects(() => embedder.embed(['a']), /dimension/);
});

test('embeds nothing without loading the model', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls) });
  assert.deepEqual(await embedder.embed([]), []);
  assert.equal(calls.length, 0);
});

test('prepends the role prefix and keeps the key stable without prefixes', async () => {
  const calls = [];
  const prefixed: EmbeddingConfig = { model: 'm', revision: 'r', dtype: 'q8', dimensions: 3, pooling: 'mean', queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' };
  const embedder = createEmbedder(prefixed, { pipelineFactory: fakeFactory(calls) });
  await embedder.embed(['a'], { role: 'query' });
  await embedder.embed(['b']);
  assert.deepEqual(calls.filter((c) => c.texts).flatMap((c) => c.texts), ['search_query: a', 'search_document: b']);
  assert.equal(embedder.modelKey, 'm@r@q8@mean@q=search_query: @d=search_document: ');
  assert.equal(modelKeyOf({ ...prefixed, queryPrefix: undefined, documentPrefix: undefined }), 'm@r@q8@mean');
});
