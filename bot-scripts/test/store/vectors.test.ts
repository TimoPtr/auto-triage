import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeInt8, toBlob, fromBlob, cosineFromL2 } from '../../src/store/vectors.ts';

test('quantizeInt8 maps a unit vector to the int8 range and clamps', () => {
  const q = quantizeInt8(Float32Array.from([1, -1, 0.5, 0]));
  assert.deepEqual(Array.from(q), [127, -127, 64, 0]);
  assert.deepEqual(Array.from(quantizeInt8([1.2])), [127]);
});

test('toBlob and fromBlob round-trip', () => {
  const q = Int8Array.from([3, -3, 127, -127]);
  assert.deepEqual(Array.from(fromBlob(toBlob(q))), Array.from(q));
});

test('cosineFromL2 converts the distance between scaled unit vectors', () => {
  assert.ok(Math.abs(cosineFromL2(0) - 1) < 1e-9);
  // orthogonal unit vectors scaled by 127: L2 = 127 * sqrt(2)
  assert.ok(Math.abs(cosineFromL2(127 * Math.SQRT2) - 0) < 1e-6);
});
