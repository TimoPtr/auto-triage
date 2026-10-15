export type Audience = 'user' | 'developer' | 'maintainer';

export interface IssuesConfig {
  states: ('open' | 'closed')[];
  /** Window for closed issues in days; absent means every closed issue. */
  closedWithinDays?: number;
  comments: boolean;
}

export interface DocsConfig {
  path: string;
  baseUrl: string;
  audience: Audience;
}

export interface GithubRepoConfig {
  issues?: IssuesConfig;
  docs?: DocsConfig;
}

export interface EmbeddingConfig {
  model: string;
  revision: string;
  dtype: 'fp32' | 'fp16' | 'q8';
  dimensions: number;
  pooling: 'cls' | 'mean';
}

export interface PeerConfig {
  product: string;
  repository: string;
  weight: number;
  sources?: string[];
}

export interface TriageConfig {
  minSimilarity?: number;
  confidence?: { answer?: number; links?: number };
  recheckLabel?: string;
  nextSteps?: Record<string, string>;
}

export interface Config {
  version: 1;
  product: { name: string; slug: string };
  providers: { github?: Record<string, GithubRepoConfig> };
  embedding: EmbeddingConfig;
  peers: PeerConfig[];
  triage?: TriageConfig;
  evalCases?: string;
}
