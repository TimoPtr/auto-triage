import { readIssues } from './issues.ts';
import { readDocs } from './docs.ts';
import type { GithubRepoConfig } from '../../config/types.ts';
import type { PaginatingClient, Provider } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

export interface GithubProviderDeps {
  client: PaginatingClient;
  checkouts: Record<string, string>;
  now: Date;
  raw?: RawStore;
}

/** One provider for every repository under `providers.github`. */
export function createGithubProvider(repos: Record<string, GithubRepoConfig>, { client, checkouts, now, raw }: GithubProviderDeps): Provider {
  return {
    name: 'github',
    async *items() {
      for (const [repo, repoConfig] of Object.entries(repos)) {
        if (repoConfig.issues) yield* readIssues({ client, repo, options: repoConfig.issues, now, raw });
        if (repoConfig.docs) {
          const checkoutPath = checkouts[repo];
          if (!checkoutPath) throw new Error(`No checkout for ${repo}; pass --checkout ${repo}=<path>`);
          yield* readDocs({ repo, checkoutPath, options: repoConfig.docs });
        }
      }
    },
  };
}
