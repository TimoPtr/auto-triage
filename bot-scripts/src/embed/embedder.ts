import type { EmbeddingConfig } from '../config/types.ts';

/** Which prefix a text gets: a question or an indexed chunk. */
export type EmbedRole = 'query' | 'document';

export interface Embedder {
  modelKey: string;
  dimensions: number;
  embed(texts: string[], options?: { role?: EmbedRole }): Promise<Float32Array[]>;
}

/** The subset of a transformers.js feature-extraction pipeline the embedder relies on. */
export interface Extractor {
  (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }): Promise<{ dims?: number[]; tolist(): number[][] }>;
}

export interface PipelineOptions {
  revision: string;
  dtype: string;
  cache_dir?: string;
}

export type PipelineFactory = (task: string, model: string, options: PipelineOptions) => Promise<Extractor>;

/**
 * Default factory: the transformers.js pipeline. Imported lazily because the
 * package is heavy, and tests never need it.
 */
const transformersPipeline: PipelineFactory = async (task, model, options) => {
  const { pipeline } = await import('@huggingface/transformers');
  // The pipeline union type does not narrow on a string task; the feature-extraction call shape is what we use.
  return (await pipeline(task as 'feature-extraction', model, options as never)) as unknown as Extractor;
};

/** Builds the model key recorded in the index meta. Any part changing invalidates the index; prefixes appear only when set. */
export function modelKeyOf(config: EmbeddingConfig): string {
  const key = `${config.model}@${config.revision}@${config.dtype}@${config.pooling}`;
  return config.queryPrefix || config.documentPrefix ? `${key}@q=${config.queryPrefix ?? ''}@d=${config.documentPrefix ?? ''}` : key;
}

export interface EmbedderOptions {
  pipelineFactory?: PipelineFactory;
  cacheDir?: string;
  batchSize?: number;
}

/** Creates an embedder over a local ONNX model. The pipeline is loaded on first use. */
export function createEmbedder(config: EmbeddingConfig, { pipelineFactory = transformersPipeline, cacheDir, batchSize = 32 }: EmbedderOptions = {}): Embedder {
  let extractorPromise: Promise<Extractor> | undefined;
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
    async embed(raw, { role = 'document' } = {}) {
      if (raw.length === 0) return [];
      const prefix = (role === 'query' ? config.queryPrefix : config.documentPrefix) ?? '';
      const texts = raw.map((t) => prefix + t);
      const extractor = await load();
      const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
      const results: Float32Array[] = new Array(texts.length);
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
