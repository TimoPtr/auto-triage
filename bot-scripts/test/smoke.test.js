import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node version is 24 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `expected Node >= 24, got ${process.versions.node}`);
});
