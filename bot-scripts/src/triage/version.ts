import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);
const SEMVER = /^\d+\.\d+\.\d+$/;

/** The release of the bot scripts, from the package version bumped at each release; fails on anything but a plain semver. */
export function botVersion(): string {
  const { version } = JSON.parse(readFileSync(fileURLToPath(PACKAGE_JSON), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`package.json version is not a release version: ${JSON.stringify(version)}`);
  return version;
}
