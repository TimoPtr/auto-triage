// @ts-check
import { readIssues } from './issues.js';
import { readDocs } from './docs.js';

/** @typedef {import('../types.js').Provider} Provider */

/**
 * One provider for every repository under `providers.github`.
 * @param {Record<string, import('../../config/types.js').GithubRepoConfig>} repos
 * @param {{ client: { paginate(path: string, params?: object): AsyncIterable<any> }, checkouts: Record<string, string>, now: Date }} deps
 * @returns {Provider}
 */
export function createGithubProvider(repos, { client, checkouts, now }) {
  return {
    name: 'github',
    async *items() {
      for (const [repo, repoConfig] of Object.entries(repos)) {
        if (repoConfig.issues) yield* readIssues({ client, repo, options: repoConfig.issues, now });
        if (repoConfig.docs) {
          const checkoutPath = checkouts[repo];
          if (!checkoutPath) throw new Error(`No checkout for ${repo}; pass --checkout ${repo}=<path>`);
          yield* readDocs({ repo, checkoutPath, options: repoConfig.docs });
        }
      }
    },
  };
}
