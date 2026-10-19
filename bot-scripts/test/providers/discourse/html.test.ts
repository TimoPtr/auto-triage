import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../../../src/providers/discourse/html.ts';

test('strips tags, keeps paragraph breaks and decodes entities', () => {
  assert.equal(htmlToText('<p>My <strong>widget</strong> stops &amp; never refreshes.</p><p>Android 15.</p>'), 'My widget stops & never refreshes.\n\nAndroid 15.');
  assert.equal(htmlToText('line<br>break &lt;x&gt; &#8220;q&#8221;'), 'line\nbreak <x> “q”');
});

test('keeps code blocks as fenced text', () => {
  assert.equal(htmlToText('<pre><code>key: value\n</code></pre>'), '```\nkey: value\n```');
});
