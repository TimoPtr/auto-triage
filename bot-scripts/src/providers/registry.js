// @ts-check
import { createGitHubClient } from './github/client.js';
import { createGithubProvider } from './github/index.js';

/** @typedef {import('./types.js').Provider} Provider */

/**
 * Builds the provider list for a config. The registry is the only place that
 * knows which top-level key maps to which factory.
 * @param {import('../config/types.js').Config} config
 * @param {{ githubToken?: string, fetchImpl?: typeof fetch, checkouts?: Record<string, string>, now?: Date }} deps
 * @returns {Provider[]}
 */
export function createProviders(config, { githubToken, fetchImpl, checkouts = {}, now = new Date() }) {
  const providers = /** @type {Provider[]} */ ([]);
  if (config.providers.github) {
    if (!githubToken) throw new Error('GITHUB_TOKEN is required for the github provider');
    const client = createGitHubClient({ token: githubToken, fetchImpl });
    providers.push(createGithubProvider(config.providers.github, { client, checkouts, now }));
  }
  return providers;
}
