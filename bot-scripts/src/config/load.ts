import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Ajv, type ErrorObject } from 'ajv';
import type { Config } from './types.ts';

const SCHEMAS_DIR = new URL('../../../schemas/', import.meta.url);

type JsonSchema = Record<string, unknown>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readSchema(relative: string): JsonSchema {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, SCHEMAS_DIR)), 'utf8')) as JsonSchema;
}

/**
 * The provider schemas shipped with this repository, keyed by the top-level
 * key they validate under `providers`.
 */
export function defaultProviderSchemas(): Record<string, JsonSchema> {
  return { github: readSchema('providers/github.json') };
}

function buildValidator(providerSchemas: Record<string, JsonSchema>) {
  const base = readSchema('config.base.json');
  const properties = base.properties as Record<string, JsonSchema>;
  const providers = properties.providers as JsonSchema;
  providers.properties = Object.fromEntries(
    Object.entries(providerSchemas).map(([key, schema]) => {
      const { $id, $schema, ...rest } = schema;
      return [key, rest];
    }),
  );
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true, allowUnionTypes: true });
  ajv.addFormat('uri', /^https?:\/\/\S+$/);
  return ajv.compile(base);
}

function describe(error: ErrorObject): string {
  const where = error.instancePath ? error.instancePath.slice(1).replaceAll('/', '.') : '(root)';
  const extra = (error.params as { additionalProperty?: string }).additionalProperty;
  return `${where}: ${error.message}${extra ? ` (${extra})` : ''}`;
}

/** Validates a parsed config in place, applying schema defaults. */
export function validateConfig(config: unknown, providerSchemas: Record<string, JsonSchema> = defaultProviderSchemas()): Config {
  const validate = buildValidator(providerSchemas);
  if (!validate(config)) {
    const lines = (validate.errors ?? []).map(describe);
    throw new ConfigError(`Invalid knowledge-bot config:\n  ${lines.join('\n  ')}`);
  }
  return config as Config;
}

/** Reads and validates a YAML config file. */
export function loadConfig(path: string, { providerSchemas }: { providerSchemas?: Record<string, JsonSchema> } = {}): Config {
  const parsed: unknown = YAML.parse(readFileSync(path, 'utf8'));
  return validateConfig(parsed, providerSchemas);
}
