import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanIssueText } from '../../src/text/clean.js';

test('strips HTML comments and images', () => {
  const { text } = cleanIssueText('<!-- READ THIS FIRST -->\nWidget ![shot](https://x/a.png) breaks <img src="x.png">.');
  assert.equal(text, 'Widget breaks .');
});

test('drops bold template labels but keeps their values', () => {
  const body = '**Home Assistant Android app version(s):**\n2026.9.1\n\n**Android version(s):**\n14\n\n**Description of problem:**\nWidget stops.';
  const { text } = cleanIssueText(body);
  assert.equal(text, '2026.9.1\n\n14\n\nWidget stops.');
});

test('moves long fenced blocks and log-like blocks to logs', () => {
  const log = Array.from({ length: 8 }, (_, i) => `10-12 09:15:${i} E/WidgetProvider: boom ${i}`).join('\n');
  const body = `Widget stops.\n\n\`\`\`\n${log}\n\`\`\`\n\nShort fence:\n\n\`\`\`yaml\nkey: value\n\`\`\``;
  const { text, logs } = cleanIssueText(body);
  assert.ok(text.includes('key: value'));
  assert.ok(!text.includes('boom 3'));
  assert.ok(logs.includes('boom 3'));
});

test('a three line block with a stack trace counts as a log', () => {
  const body = 'Crash:\n\n```\njava.lang.NullPointerException\n\tat io.homeassistant.companion.android.widgets.Foo.bar(Foo.kt:12)\n\tat android.os.Handler.handleCallback(Handler.java:1)\n```';
  const { text, logs } = cleanIssueText(body);
  assert.equal(text, 'Crash:');
  assert.ok(logs.includes('NullPointerException'));
});

test('returns empty text and null logs for a template-only body', () => {
  const { text, logs } = cleanIssueText('**Companion App Logs:**\n\n```\n\n```\n');
  assert.equal(text, '');
  assert.equal(logs, null);
});

test('a huge single-token block does not stall the log detector', () => {
  const blob = 'A'.repeat(200_000);
  const started = performance.now();
  const { logs } = cleanIssueText('```\n' + blob + '\n```');
  assert.ok(performance.now() - started < 500, 'took too long');
  assert.equal(logs, null);
});
