import type { GitHubClient } from '../providers/github/client.ts';

/** owner/name as GitHub allows them: an owner starts alphanumeric, a name is never `.` or `..`. */
const REPOSITORY = /^[A-Za-z0-9][\w-]*\/(?!\.{1,2}$)[\w.-]+$/;

export interface TriageIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  /** `User`, `Bot`, or whatever the API reports for the author. */
  authorType: string;
  isPullRequest: boolean;
  state: string;
}

export interface ApiIssue {
  number: number;
  title: string;
  body?: string | null;
  labels?: { name: string }[];
  created_at: string;
  user?: { type?: string } | null;
  pull_request?: unknown;
  state: string;
}

/** Reads one issue to triage; the repository and number are checked before any request. */
export async function fetchIssue(client: Pick<GitHubClient, 'getJson'>, repo: string, number: number): Promise<TriageIssue> {
  if (!REPOSITORY.test(repo)) throw new Error(`repository must be owner/name, got ${repo}`);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`issue number must be a positive integer, got ${number}`);
  return toTriageIssue(await client.getJson<ApiIssue>(`repos/${repo}/issues/${number}`));
}

/** The fields the triage keeps from an issue payload (REST `GET /repos/{repo}/issues/{n}`). */
export function toTriageIssue(issue: ApiIssue): TriageIssue {
  if (!Number.isInteger(issue.number) || issue.number <= 0) throw new Error('issue payload has no number');
  return {
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    labels: (issue.labels ?? []).map((l) => l.name),
    createdAt: issue.created_at,
    authorType: issue.user?.type ?? 'User',
    isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
    state: issue.state,
  };
}
