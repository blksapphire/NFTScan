#!/usr/bin/env node

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  loadState,
  saveState,
  startOutcome,
  recordOutcomeSnapshot,
  finalizeOutcome,
  pruneOutcomes,
} from '../src/state.js';

const file = join(tmpdir(), `nftscan-research-${process.pid}.json`);
rmSync(file, { force: true });

const state = loadState(file);
assert.equal(state.version, 2);
assert.deepEqual(state.outcomes, []);

const created = startOutcome(state, {
  contractAddress: '0xABC',
  kind: 'live',
  name: 'Example',
  score: 84,
  confidence: 0.92,
  riskMultiplier: 1,
  mintPriceEth: 0.03,
});

assert.equal(created.key, '0xabc|live');
assert.equal(created.score, 84);
assert.equal(created.observations.length, 0);

const duplicate = startOutcome(state, {
  contractAddress: '0xabc',
  kind: 'live',
  name: 'Duplicate',
  score: 99,
});
assert.equal(duplicate.key, created.key);
assert.equal(state.outcomes.length, 1);

const first = recordOutcomeSnapshot(state, '0xabc', 'live', {
  floorEth: 0.04,
  volumeEth: 5,
  sales: 31,
  uniqueBuyers: 24,
  uniqueSellers: 17,
});
assert.equal(first.floorEth, 0.04);
assert.equal(state.outcomes[0].observations.length, 1);

for (let i = 0; i < 30; i += 1) {
  recordOutcomeSnapshot(state, '0xabc', 'live', { floorEth: 0.04 + i * 0.001 });
}
assert.equal(state.outcomes[0].observations.length, 24);
assert.equal(state.outcomes[0].observations.at(-1).floorEth, 0.069);

const closed = finalizeOutcome(state, '0xabc', 'live');
assert.ok(closed.closedAt);

saveState(file, state);
const roundTrip = loadState(file);
assert.equal(roundTrip.version, 2);
assert.equal(roundTrip.outcomes[0].observations.length, 24);
assert.equal(roundTrip.outcomes[0].closedAt, closed.closedAt);

roundTrip.outcomes.push({ key: 'old', alertedAt: '2000-01-01T00:00:00.000Z' });
const removed = pruneOutcomes(roundTrip, 30, Date.parse('2026-08-24T00:00:00Z'));
assert.equal(removed, 1);

rmSync(file, { force: true });
console.log('research tests: PASS');
