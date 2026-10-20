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

export interface PullsConfig {
  /** `closed` means closed without merge. */
  states: ('merged' | 'closed')[];
  closedWithinDays?: number;
  reviews: boolean;
  excludeBots: boolean;
}

export interface DiscussionsConfig {
  /** Category slugs. */
  categories: string[];
  answers: boolean;
}

export interface ReleasesConfig {
  includePrereleases: boolean;
  withinDays?: number;
}

export interface CodeConfig {
  include: string[];
  exclude: string[];
  /** Branch used in the source links. */
  ref: string;
  audience: Audience;
}

export interface FileConfig {
  path: string;
  kind: 'strings' | 'markdown';
  audience: Audience;
}

export interface GithubRepoConfig {
  issues?: IssuesConfig;
  pulls?: PullsConfig;
  discussions?: DiscussionsConfig;
  releases?: ReleasesConfig;
  docs?: DocsConfig;
  code?: CodeConfig;
  files?: FileConfig[];
}

export interface DiscourseSiteConfig {
  /** Category slugs or numeric ids as strings. */
  categories: string[];
  tags: string[];
  solvedOnly: boolean;
  acceptedAnswers: boolean;
  closedWithinDays?: number;
  requestsPerSecond: number;
}

export interface EmbeddingConfig {
  model: string;
  revision: string;
  dtype: 'fp32' | 'fp16' | 'q8';
  dimensions: number;
  pooling: 'cls' | 'mean';
  /** Prepended to a question before embedding; some models expect one (`search_query: `). */
  queryPrefix?: string;
  /** Prepended to every indexed chunk before embedding. */
  documentPrefix?: string;
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
  providers: { github?: Record<string, GithubRepoConfig>; discourse?: Record<string, DiscourseSiteConfig> };
  embedding: EmbeddingConfig;
  peers: PeerConfig[];
  triage?: TriageConfig;
  evalCases?: string;
}
