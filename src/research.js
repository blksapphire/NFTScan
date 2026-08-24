#!/usr/bin/env node
/**
 * Small, dependency-free research ledger for NFTScan.
 *
 * It does not execute trades. It records alert outcomes so the heuristic score
 * can eventually be calibrated against actual market behaviour.
 *
 * Examples:
 *   npm run research
 *   node src/research.js add --contract 0x... --score 84 --mint 0.03 --floor 0.04 --kind live
 *   node src/research.js snapshot --contract 0x... --floor 0.05 --volume 12
 */

import { resolve } from 'node:path';
import { loadState, saveState, startOutcome, recordOutcomeSnapshot } from './state.js';
import { ROOT } from './config.js';

const STATE_FILE = resolve(ROOT, process.env.STATE_FILE || './state.json');
const argv = process.argv.slice(2);
const command = argv[0] || 'report';

function value(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function num(name) {
  const n = Number(value(name));
  return Number.isFinite(n) ? n : null;
}

function printRecord(record) {
  console.log(`${record.name} | ${record.contractAddress} | score ${record.score ?? '?'} | ${record.observations.length} observations`);
  if (record.observations.length) {
    const first = record.observations[0];
    const last = record.observations[record.observations.length - 1];
    console.log(`  first floor: ${first.floorEth ?? '?'} ETH`);
    console.log(`  latest floor: ${last.floorEth ?? '?'} ETH`);
    console.log(`  latest volume: ${last.volumeEth ?? '?'} ETH`);
  }
}

function report(state) {
  const records = Array.isArray(state.outcomes) ? state.outcomes : [];
  console.log(`\nNFTScan research ledger`);
  console.log(`Records: ${records.length}`);

  if (!records.length) {
    console.log('\nNo outcome records yet. Start recording alerts with:');
    console.log('  node src/research.js add --contract 0x... --score 84 --mint 0.03 --floor 0.04 --kind live');
    return;
  }

  const closed = records.filter((r) => r.closedAt);
  const withFloor = records.filter((r) => r.mintPriceEth > 0 && r.observations.some((o) => Number.isFinite(o.floorEth)));
  let returns = 0;
  let returnCount = 0;

  for (const record of withFloor) {
    const mint = Number(record.mintPriceEth);
    const last = [...record.observations].reverse().find((o) => Number.isFinite(o.floorEth));
    if (mint > 0 && last) {
      returns += last.floorEth / mint - 1;
      returnCount++;
    }
  }

  console.log(`Closed: ${closed.length}`);
  if (returnCount) console.log(`Average observed floor return: ${(returns / returnCount * 100).toFixed(1)}%`);
  console.log('\nRecent records:');
  records.slice(0, 10).forEach(printRecord);
}

const state = loadState(STATE_FILE);

if (command === 'add') {
  const contract = value('contract');
  if (!contract) throw new Error('--contract is required');
  const record = startOutcome(state, {
    contractAddress: contract,
    kind: value('kind', 'live'),
    name: value('name', contract),
    chain: value('chain', 'ethereum'),
    score: num('score'),
    confidence: num('confidence'),
    riskMultiplier: num('risk'),
    mintPriceEth: num('mint'),
  });

  if (value('floor') !== undefined || value('volume') !== undefined) {
    recordOutcomeSnapshot(state, contract, value('kind', 'live'), {
      floorEth: num('floor'),
      volumeEth: num('volume'),
      sales: num('sales'),
      uniqueBuyers: num('buyers'),
      uniqueSellers: num('sellers'),
      holders: num('holders'),
      listingsPct: num('listingsPct'),
    });
  }

  saveState(STATE_FILE, state);
  console.log(`Recorded ${record.name} (${record.key})`);
  process.exit(0);
}

if (command === 'snapshot') {
  const contract = value('contract');
  if (!contract) throw new Error('--contract is required');
  const observation = recordOutcomeSnapshot(state, contract, value('kind', 'live'), {
    floorEth: num('floor'),
    volumeEth: num('volume'),
    sales: num('sales'),
    uniqueBuyers: num('buyers'),
    uniqueSellers: num('sellers'),
    holders: num('holders'),
    listingsPct: num('listingsPct'),
  });
  if (!observation) throw new Error('No matching outcome record. Add it first.');
  saveState(STATE_FILE, state);
  console.log(`Recorded observation at ${observation.at}`);
  process.exit(0);
}

if (command === 'report') {
  report(state);
  process.exit(0);
}

throw new Error(`Unknown command: ${command}. Use report, add, or snapshot.`);
