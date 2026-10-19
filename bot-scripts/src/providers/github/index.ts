import { readIssues } from './issues.ts';
import { readPulls } from './pulls.ts';
import { readDiscussions } from './discussions.ts';
import { readReleases } from './releases.ts';
import { readDocs } from './docs.ts';
import { readCode } from './code.ts';
import { readFiles } from './files.ts';
import type { GithubRepoConfig } from '../../config/types.ts';
import type { PaginatingClient, Provider } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

export interface GithubProviderDeps {
  client: PaginatingClient;
  checkouts: Record<string, string>;
  now: Date;
  raw?: RawStore;
}

/** One provider for every repository under `providers.github`, sources in a fixed order per repository. */
export function createGithubProvider(repos: Record<string, GithubRepoConfig>, { client, checkouts, now, raw }: GithubProviderDeps): Provider {
  const checkoutOf = (repo: string, what: string) => {
    const path = checkouts[repo];
    if (!path) throw new Error(`No checkout for ${repo} (needed for ${what}); pass --checkout ${repo}=<path>`);
    return path;
  };
  return {
    name: 'github',
    async *items() {
      for (const [repo, c] of Object.entries(repos)) {
        if (c.issues) yield* readIssues({ client, repo, options: c.issues, now, raw });
        if (c.pulls) yield* readPulls({ client, repo, options: c.pulls, now, raw });
        if (c.discussions) yield* readDiscussions({ client, repo, options: c.discussions, raw });
        if (c.releases) yield* readReleases({ client, repo, options: c.releases, now, raw });
        if (c.docs) yield* readDocs({ repo, checkoutPath: checkoutOf(repo, 'docs'), options: c.docs });
        if (c.code) yield* readCode({ repo, checkoutPath: checkoutOf(repo, 'code'), options: c.code });
        if (c.files?.length) yield* readFiles({ repo, checkoutPath: checkoutOf(repo, 'files'), entries: c.files, ref: c.code?.ref ?? 'main' });
      }
    },
  };
}
