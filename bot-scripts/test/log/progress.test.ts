import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle, PROGRESS_INTERVAL_MS } from '../../src/log/progress.ts';

test('emits at most once per interval, never on the first call', () => {
  let clock = 0;
  const tick = throttle(1000, () => clock);
  let emitted = 0;
  tick(() => { emitted += 1; });
  assert.equal(emitted, 0, 'nothing right at the start');
  clock = 999; tick(() => { emitted += 1; });
  assert.equal(emitted, 0);
  clock = 1000; tick(() => { emitted += 1; });
  assert.equal(emitted, 1);
  clock = 1500; tick(() => { emitted += 1; });
  assert.equal(emitted, 1, 'only one per interval');
  clock = 2100; tick(() => { emitted += 1; });
  assert.equal(emitted, 2);
  assert.equal(PROGRESS_INTERVAL_MS, 60_000);
});
