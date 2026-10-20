import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBuild, FULL_REBUILD_DAYS, SINCE_OVERLAP_MS } from '../../src/index/plan.ts';

const now = new Date('2026-10-20T03:00:00Z');
const meta = { started_at: '2026-10-19T03:00:00Z', built_at: '2026-10-19T03:05:00Z', full_built_at: '2026-10-15T03:00:00Z', config_hash: 'abc' };

test('incremental since the previous start minus the overlap', () => {
  const plan = planBuild({ previousMeta: meta, configHash: 'abc', now, full: false });
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.since.toISOString(), '2026-10-19T02:00:00.000Z');
  assert.equal(SINCE_OVERLAP_MS, 3600_000);
  assert.equal(plan.fullBuiltAt, '2026-10-15T03:00:00Z');
  assert.match(plan.reason, /incremental since 2026-10-19T02:00:00.000Z/);
});

test('full when forced, when there is no previous index, or when started_at is missing', () => {
  assert.equal(planBuild({ previousMeta: meta, configHash: 'abc', now, full: true }).reason, 'forced');
  assert.equal(planBuild({ previousMeta: null, configHash: 'abc', now, full: false }).reason, 'no previous index');
  const { started_at, ...legacy } = meta;
  const plan = planBuild({ previousMeta: legacy, configHash: 'abc', now, full: false });
  assert.equal(plan.mode, 'full');
  assert.equal(plan.reason, 'previous index has no started_at');
  assert.equal(plan.since, null);
});

test('full when the config hash changed', () => {
  const plan = planBuild({ previousMeta: meta, configHash: 'def', now, full: false });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /config hash/);
});

test('full when the last full build is older than FULL_REBUILD_DAYS', () => {
  assert.equal(FULL_REBUILD_DAYS, 7);
  const old = planBuild({ previousMeta: { ...meta, full_built_at: '2026-10-12T03:00:00Z' }, configHash: 'abc', now, full: false });
  assert.equal(old.mode, 'full');
  assert.match(old.reason, /last full build 8 days ago/);
  assert.equal(old.fullBuiltAt, now.toISOString());
  const recent = planBuild({ previousMeta: { ...meta, full_built_at: '2026-10-13T04:00:00Z' }, configHash: 'abc', now, full: false });
  assert.equal(recent.mode, 'incremental');
  assert.equal(planBuild({ previousMeta: { ...meta, full_built_at: undefined }, configHash: 'abc', now, full: false }).mode, 'full');
});
