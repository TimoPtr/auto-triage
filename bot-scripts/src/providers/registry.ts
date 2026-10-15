import { createGitHubClient } from './github/client.ts';
import { createGithubProvider } from './github/index.ts';
import type { Config } from '../config/types.ts';
import type { Provider } from './types.ts';

export interface ProviderDeps {
  githubToken?: string;
  fetchImpl?: typeof fetch;
  checkouts?: Record<string, string>;
  now?: Date;
}

/**
 * Builds the provider list for a config. The registry is the only place that
 * knows which top-level key maps to which factory.
 */
export function createProviders(config: Config, { githubToken, fetchImpl, checkouts = {}, now = new Date() }: ProviderDeps): Provider[] {
  const providers: Provider[] = [];
  if (config.providers.github) {
    if (!githubToken) throw new Error('GITHUB_TOKEN is required for the github provider');
    const client = createGitHubClient({ token: githubToken, fetchImpl });
    providers.push(createGithubProvider(config.providers.github, { client, checkouts, now }));
  }
  return providers;
}
