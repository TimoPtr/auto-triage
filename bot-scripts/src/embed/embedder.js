// @ts-check

/**
 * @typedef {{ modelKey: string, dimensions: number, embed(texts: string[]): Promise<Float32Array[]> }} Embedder
 * @typedef {import('../config/types.js').EmbeddingConfig} EmbeddingConfig
 */

/**
 * Default factory: the transformers.js pipeline. Imported lazily because the
 * package is ESM-only and heavy, and tests never need it.
 * @param {string} task
 * @param {string} model
 * @param {object} options
 */
async function transformersPipeline(task, model, options) {
  const { pipeline } = await import('@huggingface/transformers');
  return pipeline(/** @type {any} */ (task), model, options);
}

/**
 * Builds the model key recorded in the index meta. Any part changing invalidates the index.
 * @param {EmbeddingConfig} config
 */
export function modelKeyOf(config) {
  return `${config.model}@${config.revision}@${config.dtype}@${config.pooling}`;
}

/**
 * Creates an embedder over a local ONNX model. The pipeline is loaded on first use.
 * @param {EmbeddingConfig} config
 * @param {{ pipelineFactory?: typeof transformersPipeline, cacheDir?: string, batchSize?: number }} [options]
 * @returns {Embedder}
 */
export function createEmbedder(config, { pipelineFactory = transformersPipeline, cacheDir, batchSize = 32 } = {}) {
  /** @type {Promise<any> | undefined} */
  let extractorPromise;
  const load = () => {
    extractorPromise ??= pipelineFactory('feature-extraction', config.model, {
      revision: config.revision,
      dtype: config.dtype,
      cache_dir: cacheDir,
    });
    return extractorPromise;
  };

  return {
    modelKey: modelKeyOf(config),
    dimensions: config.dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const extractor = await load();
      const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
      const results = /** @type {Float32Array[]} */ (new Array(texts.length));
      for (let start = 0; start < order.length; start += batchSize) {
        const batch = order.slice(start, start + batchSize);
        const output = await extractor(batch.map((i) => texts[i]), { pooling: config.pooling, normalize: true });
        if (output.dims?.length !== 2 || output.dims[1] !== config.dimensions) {
          throw new Error(`Embedding dimension mismatch: expected [n, ${config.dimensions}], got [${output.dims}]`);
        }
        const rows = output.tolist();
        batch.forEach((i, k) => {
          results[i] = Float32Array.from(rows[k]);
        });
      }
      return results;
    },
  };
}
