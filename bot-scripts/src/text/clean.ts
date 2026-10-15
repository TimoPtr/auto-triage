const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const TEMPLATE_LABEL = /^\s*\*\*[^*\n]+:\*\*\s*$/;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;
const LOG_LINE = /^\s*(at\s+[\w.$<>]+\(|\d{2}-\d{2}\s\d{2}:\d{2}|[VDIWEF]\/\w+|\w+(Exception|Error)\b)/m;

export interface CleanedText {
  text: string;
  logs: string | null;
}

/** Decides whether a fenced block is a log rather than configuration or a short snippet. */
function looksLikeLog(body: string, maxLogLines: number): boolean {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  return lines.length > maxLogLines || LOG_LINE.test(body);
}

/**
 * Removes template noise from an issue or comment body and separates logs for
 * the lexical index.
 */
export function cleanIssueText(markdown: string, { maxLogLines = 5 }: { maxLogLines?: number } = {}): CleanedText {
  const logs: string[] = [];
  let text = markdown
    .replace(/\r\n/g, '\n')
    .replace(HTML_COMMENT, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(HTML_IMAGE, '')
    .replace(FENCED_BLOCK, (whole: string, body: string) => {
      const trimmed = body.trim();
      if (trimmed === '') return '';
      if (!looksLikeLog(trimmed, maxLogLines)) return whole;
      logs.push(trimmed);
      return '';
    });
  text = text
    .split('\n')
    .filter((line) => !TEMPLATE_LABEL.test(line))
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, logs: logs.length ? logs.join('\n\n') : null };
}
