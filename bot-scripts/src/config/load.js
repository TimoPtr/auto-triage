// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv from 'ajv';

const SCHEMAS_DIR = new URL('../../../schemas/', import.meta.url);

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {string} relative */
function readSchema(relative) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, SCHEMAS_DIR)), 'utf8'));
}

/**
 * The provider schemas shipped with this repository, keyed by the top-level
 * key they validate under `providers`.
 * @returns {Record<string, object>}
 */
export function defaultProviderSchemas() {
  return { github: readSchema('providers/github.json') };
}

/**
 * @param {Record<string, object>} providerSchemas
 */
function buildValidator(providerSchemas) {
  const base = readSchema('config.base.json');
  base.properties.providers.properties = Object.fromEntries(
    Object.entries(providerSchemas).map(([key, schema]) => {
      const { $id, $schema, ...rest } = /** @type {Record<string, unknown>} */ (schema);
      return [key, rest];
    }),
  );
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true, allowUnionTypes: true });
  ajv.addFormat('uri', /^https?:\/\/\S+$/);
  return ajv.compile(base);
}

/**
 * Validates a parsed config in place, applying schema defaults.
 * @param {unknown} config
 * @param {Record<string, object>} [providerSchemas]
 * @returns {import('./types.js').Config}
 */
export function validateConfig(config, providerSchemas = defaultProviderSchemas()) {
  const validate = buildValidator(providerSchemas);
  if (!validate(config)) {
    const lines = (validate.errors ?? []).map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : '(root)';
      const detail = e.params && 'additionalProperty' in e.params ? `${e.message} (${e.params.additionalProperty})` : e.message;
      return `${where}: ${detail}`;
    });
    throw new ConfigError(`Invalid knowledge-bot config:\n  ${lines.join('\n  ')}`);
  }
  return /** @type {import('./types.js').Config} */ (config);
}

/**
 * Reads and validates a YAML config file.
 * @param {string} path
 * @param {{ providerSchemas?: Record<string, object> }} [options]
 */
export function loadConfig(path, { providerSchemas } = {}) {
  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  return validateConfig(parsed, providerSchemas);
}
