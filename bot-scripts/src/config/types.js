// @ts-check
/**
 * @typedef {{ states: ('open'|'closed')[], closedWithinDays: number, comments: boolean }} IssuesConfig
 * @typedef {{ path: string, baseUrl: string, audience: 'user'|'developer'|'maintainer' }} DocsConfig
 * @typedef {{ issues?: IssuesConfig, docs?: DocsConfig }} GithubRepoConfig
 * @typedef {{ model: string, revision: string, dtype: 'fp32'|'fp16'|'q8', dimensions: number, pooling: 'cls'|'mean' }} EmbeddingConfig
 * @typedef {{
 *   version: 1,
 *   product: { name: string, slug: string },
 *   providers: { github?: Record<string, GithubRepoConfig> },
 *   embedding: EmbeddingConfig,
 *   peers: object[],
 *   triage?: object,
 *   evalCases?: string,
 * }} Config
 */
export {};
