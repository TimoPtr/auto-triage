#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.ts';
import { DEFAULT_FRESH_DAYS, indexStatus, rawVersions } from '../index/status.ts';

/** Appends `key=value` lines to the GitHub Actions output file when one is set; null becomes empty. */
export function writeOutputs(values: Record<string, string | number | boolean | null>, outputFile = process.env.GITHUB_OUTPUT): void {
  if (!outputFile) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value === null ? '' : String(value)}`);
  appendFileSync(outputFile, `${lines.join('\n')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      index: { type: 'string' },
      'fresh-days': { type: 'string', default: String(DEFAULT_FRESH_DAYS) },
      versions: { type: 'boolean', default: false },
    },
  });

  if (values.versions) {
    const v = rawVersions();
    console.log(JSON.stringify(v));
    writeOutputs({ 'format-version': v.formatVersion, 'schema-version': v.schemaVersion, 'raw-schema-version': v.rawSchemaVersion });
  } else {
    const freshDays = Number(values['fresh-days']);
    if (!values.config || !values.index || !(freshDays > 0)) {
      console.error('usage: index-status --config <knowledge-bot.yaml> --index <knowledge.sqlite> [--fresh-days 2] | --versions');
      process.exit(2);
    }
    const status = indexStatus({ indexPath: values.index, config: loadConfig(values.config), freshDays });
    console.log(JSON.stringify(status));
    writeOutputs({
      found: status.found, usable: status.usable, status: status.status, reason: status.reason, 'built-at': status.builtAt,
      'age-days': status.ageDays === null ? null : status.ageDays.toFixed(2), items: status.items, chunks: status.chunks,
      'format-version': status.formatVersion, 'schema-version': status.schemaVersion,
    });
  }
}
