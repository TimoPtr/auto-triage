import { existsSync, readFileSync } from 'node:fs';

/** The outputs a CLI wrote to a GITHUB_OUTPUT file, parsed the way Actions does: heredoc blocks, last value wins. */
export function readOutputs(path: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  if (!existsSync(path)) return outputs;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (!heredoc) continue;
    const end = lines.indexOf(heredoc[2], i + 1);
    if (end === -1) throw new Error(`unterminated output ${heredoc[1]} in ${path}`);
    outputs[heredoc[1]] = lines.slice(i + 1, end).join('\n');
    i = end;
  }
  return outputs;
}
