/**
 * Offline self-test.
 *
 * No network, no API key, no Telegram. Runs the pure logic — scoring, mint
 * detection, lead-time buckets, dedupe, formatting — against synthetic
 * fixtures, including the adversarial cases that matter: wash-minted
 * collections, concentrated ownership, spam airdrops.
 *
 *   npm run selftest
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from '../src/config.js';
import { scoreCandidate, normalisePercentages } from '../src/score.js';
import { MintTracker, parseTransferEvent } from '../src/mints.js';
import { dueLeadBucket } from '../src/sources.js';
import { formatAlert } from '../src/telegram.js';
import {
  wasAlerted,
  markAlerted,
  pruneState,
  recordRecent,
  alertKey,
  loadState,
  saveState,
} from '../src/state.js';
import { weiToEth, isMintTransfer, ramp, ZERO_ADDRESS } from '../src/util.js';
import { OpenSeaClient, OpenSeaError } from '../src/opensea.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = stripComments(JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')));

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function near(name, actual, expected, tolerance = 0.001) {
  check(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `expected ~${expected}, got ${actual}`
  );
}

const NOW = Date.parse('2026-08-22T12:00:00Z');
const HOUR = 3600 * 1000;

/** A candidate that should score well, used as the baseline to mutate. */
function goodCandidate(overrides = {}) {
  return {
    kind: 'live',
    alertKind: 'live',
    name: 'Healthy Collection',
    slug: 'healthy',
    chain: 'ethereum',
    contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    openseaUrl: 'https://opensea.io/collection/healthy',
    mintPriceEth: 0.03,
    isNativeCurrency: true,
    maxPerWallet: 2,
    totalSupply: 5000,
    createdAtMs: NOW - 2 * HOUR,
    safelistStatus: 'approved',
    socials: { twitter: 'healthy', discord: 'https://discord.gg/x', website: 'https://x.com', telegram: null },
    isNsfw: false,
    isDisabled: false,
    totalMints: 400,
    uniqueMinters: 350,
    mintsPerMinute: 40,
    topHolders: [
      { address: '0x1', quantity: 5, percentage: 1.2 },
      { address: '0x2', quantity: 4, percentage: 1.0 },
      { address: '0x3', quantity: 3, percentage: 0.8 },
    ],
    detectedAtMs: NOW,
    ...overrides,
  };
}

// --- Shipped config sanity -------------------------------------------------

{
  const sum = Object.values(CONFIG.weights).reduce((a, b) => a + Number(b), 0);
  eq('shipped config weights sum to 100', sum, 100);
  check('shipped config has lead times', Array.isArray(CONFIG.leadTimeMinutes) && CONFIG.leadTimeMinutes.length >= 1);
  check(
    'shipped request budget respects the 600/hour free tier at 12 runs/hour',
    CONFIG.budget.maxRequestsPerRun * 12 <= 600,
    `${CONFIG.budget.maxRequestsPerRun} x 12 = ${CONFIG.budget.maxRequestsPerRun * 12}`
  );
}

// --- Unit helpers ----------------------------------------------------------

{
  near('weiToEth: 1 ETH', weiToEth('1000000000000000000'), 1);
  near('weiToEth: 0.005 ETH', weiToEth('5000000000000000'), 0.005);
  near('weiToEth: 0.029 ETH', weiToEth('29000000000000000'), 0.029);
  eq('weiToEth: zero', weiToEth('0'), 0);
  eq('weiToEth: null', weiToEth(null), null);
  eq('weiToEth: garbage', weiToEth('not-a-number'), null);
  // Above Number.MAX_SAFE_INTEGER — the reason this uses BigInt at all.
  near('weiToEth: 12345 ETH stays precise', weiToEth('12345000000000000000000'), 12345, 0.01);

  eq('isMintTransfer: zero address', isMintTransfer(ZERO_ADDRESS), true);
  eq('isMintTransfer: uppercase zero address', isMintTransfer(ZERO_ADDRESS.toUpperCase()), true);
  eq('isMintTransfer: normal wallet', isMintTransfer('0xabc'), false);
  eq('isMintTransfer: null', isMintTransfer(null), false);

  eq('ramp below min', ramp(0, 10, 20), 0);
  eq('ramp above max', ramp(30, 10, 20), 1);
  near('ramp midpoint', ramp(15, 10, 20), 0.5);
}

// --- Holder percentage normalisation --------------------------------------

{
  // The docs do not say whether `percentage` is 0-1 or 0-100, so both must work.
  const asPercent = normalisePercentages([{ percentage: 40 }, { percentage: 20 }]);
  eq('percentages already 0-100 are untouched', asPercent.join(','), '40,20');

  const asFraction = normalisePercentages([{ percentage: 0.4 }, { percentage: 0.2 }]);
  near('fractional percentages are scaled to 0-100', asFraction[0], 40);
  near('fractional percentages preserve ratio', asFraction[1], 20);

  eq('empty holders', normalisePercentages([]).length, 0);
  eq('null holders', normalisePercentages(null).length, 0);
  eq('non-numeric percentages are dropped', normalisePercentages([{ percentage: 'x' }]).length, 0);
}

// --- Hard rejects ----------------------------------------------------------

{
  const disabled = scoreCandidate(goodCandidate({ isDisabled: true }), CONFIG, NOW);
  check('disabled collection is rejected', disabled.rejected !== null, JSON.stringify(disabled.rejected));
  eq('rejected candidate scores zero', disabled.score, 0);

  const nsfw = scoreCandidate(goodCandidate({ isNsfw: true }), CONFIG, NOW);
  check('nsfw collection is rejected', nsfw.rejected !== null);

  const noContract = scoreCandidate(goodCandidate({ contractAddress: null }), CONFIG, NOW);
  check('missing contract address is rejected', noContract.rejected !== null);

  const spamAirdrop = scoreCandidate(
    goodCandidate({ mintPriceEth: 0, totalSupply: 50000 }),
    CONFIG,
    NOW
  );
  check('free mint with huge supply is rejected', spamAirdrop.rejected !== null, JSON.stringify(spamAirdrop.rejected));

  const tooExpensive = scoreCandidate(goodCandidate({ mintPriceEth: 12 }), CONFIG, NOW);
  check('mint above the price ceiling is rejected', tooExpensive.rejected !== null);

  // A free mint on a SMALL supply is not spam and must survive.
  const freeSmall = scoreCandidate(goodCandidate({ mintPriceEth: 0, totalSupply: 500 }), CONFIG, NOW);
  eq('free mint on small supply is not rejected', freeSmall.rejected, null);

  const staleCollection = scoreCandidate(
    goodCandidate({ kind: 'new_collection', createdAtMs: NOW - 200 * HOUR }),
    CONFIG,
    NOW
  );
  check('collection past the freshness window is rejected', staleCollection.rejected !== null);

  const startedAlready = scoreCandidate(
    goodCandidate({ kind: 'upcoming', startTimeMs: NOW - HOUR }),
    CONFIG,
    NOW
  );
  check('upcoming mint that already began is rejected', startedAlready.rejected !== null);

  const tooFarOut = scoreCandidate(
    goodCandidate({ kind: 'upcoming', startTimeMs: NOW + 400 * HOUR }),
    CONFIG,
    NOW
  );
  check('mint further out than the lead window is rejected', tooFarOut.rejected !== null);
}

// --- Scoring behaviour ----------------------------------------------------

{
  const healthy = scoreCandidate(goodCandidate(), CONFIG, NOW);
  eq('healthy candidate is not rejected', healthy.rejected, null);
  check(
    'healthy candidate clears the shipped threshold',
    healthy.score >= CONFIG.minScore,
    `scored ${healthy.score}, threshold ${CONFIG.minScore}`
  );
  eq('healthy candidate scores on all six signals', healthy.available.length, 6);

  // The headline fraud check: same volume, but one wallet doing the minting.
  const washMinted = scoreCandidate(
    goodCandidate({ totalMints: 400, uniqueMinters: 3 }),
    CONFIG,
    NOW
  );
  check(
    'wash-minted collection scores below the healthy one',
    washMinted.score < healthy.score,
    `wash ${washMinted.score} vs healthy ${healthy.score}`
  );
  check(
    'wash-minted collection falls under the shipped threshold',
    washMinted.score < CONFIG.minScore,
    `scored ${washMinted.score}`
  );
  check(
    'wash-mint reason is spelled out for the user',
    washMinted.reasons.some((r) => /self-minting|Concentrated minting/i.test(r)),
    JSON.stringify(washMinted.reasons)
  );

  // Concentrated ownership must drag the score down.
  const whaleHeld = scoreCandidate(
    goodCandidate({
      topHolders: [
        { address: '0x1', quantity: 900, percentage: 55 },
        { address: '0x2', quantity: 200, percentage: 15 },
      ],
    }),
    CONFIG,
    NOW
  );
  check(
    'whale-held collection scores below the healthy one',
    whaleHeld.score < healthy.score,
    `whale ${whaleHeld.score} vs healthy ${healthy.score}`
  );
  check(
    'whale-held collection is actually filtered out, not merely nudged',
    whaleHeld.score < CONFIG.minScore,
    `scored ${whaleHeld.score}, threshold ${CONFIG.minScore}`
  );
  check(
    'concentration is called out in the reasons',
    whaleHeld.reasons.some((r) => /Concentrated ownership/i.test(r)),
    JSON.stringify(whaleHeld.reasons)
  );

  // Unverified with no socials should score lower, but must not be rejected:
  // brand-new projects legitimately have neither yet.
  const anonymous = scoreCandidate(
    goodCandidate({ safelistStatus: 'not_requested', socials: {} }),
    CONFIG,
    NOW
  );
  eq('anonymous project is scored, not rejected', anonymous.rejected, null);
  check('anonymous project scores lower than a verified one', anonymous.score < healthy.score);
  check(
    'missing socials is surfaced to the user',
    anonymous.reasons.some((r) => /No socials listed/i.test(r))
  );
}

// --- Weight renormalisation ----------------------------------------------

{
  // This is the subtle one. A poll-mode candidate has no unique-minter count and
  // no velocity, so it is scored over four components instead of six. If the
  // weights were NOT renormalised, its score would be depressed purely by the
  // hosting mode, and `minScore: 70` would mean two different things.
  const full = goodCandidate();
  const pollShaped = goodCandidate({ totalMints: null, uniqueMinters: null, mintsPerMinute: null });

  const fullResult = scoreCandidate(full, CONFIG, NOW);
  const pollResult = scoreCandidate(pollShaped, CONFIG, NOW);

  eq('stream-shaped candidate uses six signals', fullResult.available.length, 6);
  eq('poll-shaped candidate uses four signals', pollResult.available.length, 4);
  check(
    'a strong poll-mode candidate still clears the threshold despite fewer signals',
    pollResult.score >= CONFIG.minScore,
    `poll scored ${pollResult.score}, threshold ${CONFIG.minScore}`
  );

  // Every component of this candidate is near-perfect, so both shapes should
  // land high. Without renormalisation the poll score would be roughly half.
  check(
    'poll and stream scores are on a comparable scale',
    Math.abs(pollResult.score - fullResult.score) < 25,
    `poll ${pollResult.score} vs stream ${fullResult.score}`
  );

  // The regression that renormalisation introduced on its own: dropping a
  // component that was scoring badly RAISES the average of what remains, so a
  // poll-mode candidate once scored 96 against the same collection's 85 with
  // full data. Knowing less must never score better than knowing more.
  check(
    'missing signals cannot score higher than having them',
    pollResult.score <= fullResult.score,
    `poll ${pollResult.score} must not exceed stream ${fullResult.score}`
  );

  const nothingKnown = scoreCandidate(
    {
      kind: 'live',
      contractAddress: '0xbbbb',
      name: 'Unknown',
      socials: {},
      isNsfw: false,
      isDisabled: false,
      mintPriceEth: null,
      totalSupply: null,
      createdAtMs: null,
      topHolders: null,
      totalMints: null,
      uniqueMinters: null,
      mintsPerMinute: null,
    },
    CONFIG,
    NOW
  );
  // Verification always contributes (absence of a badge is itself information),
  // so this still scores rather than dividing by zero.
  check('candidate with almost no data does not crash', Number.isFinite(nothingKnown.score));
  check(
    'candidate with almost no data scores poorly',
    nothingKnown.score < CONFIG.minScore,
    `scored ${nothingKnown.score}`
  );
}

// --- Confidence and risk multipliers --------------------------------------
//
// These exist because a purely additive score got three real cases wrong. Each
// check below pins one of those cases so it cannot come back.

{
  const healthy = scoreCandidate(goodCandidate(), CONFIG, NOW);

  eq('a full-coverage candidate takes no confidence discount', healthy.confidence, 1);
  eq('a clean candidate takes no risk penalty', healthy.riskMultiplier, 1);

  // Fewer signals means a real discount, but a survivable one.
  const upcoming = scoreCandidate(
    goodCandidate({
      kind: 'upcoming',
      startTimeMs: NOW + 3 * HOUR,
      topHolders: [],
      totalMints: null,
      uniqueMinters: null,
      mintsPerMinute: null,
    }),
    CONFIG,
    NOW
  );
  check(
    'a three-signal candidate is discounted for low coverage',
    upcoming.confidence < 1 && upcoming.confidence >= 0.75,
    `confidence ${upcoming.confidence}`
  );
  check(
    'a strong upcoming drop still clears the threshold after the discount',
    upcoming.score >= CONFIG.minScore,
    `scored ${upcoming.score}, threshold ${CONFIG.minScore}`
  );

  // Risk 1: a single wallet holding most of the supply can dump on you. As a
  // 10%-weight component this only moved 85 -> 75 and still alerted.
  const severeWhale = scoreCandidate(
    goodCandidate({ topHolders: [{ percentage: 55 }, { percentage: 2 }] }),
    CONFIG,
    NOW
  );
  check(
    'a 55% single holder applies a severe multiplier',
    severeWhale.riskMultiplier <= 0.5,
    `multiplier ${severeWhale.riskMultiplier}`
  );
  check(
    'the dump risk is stated in plain language',
    severeWhale.reasons.some((r) => /RISK:.*one wallet holds/i.test(r)),
    JSON.stringify(severeWhale.reasons)
  );

  const moderateWhale = scoreCandidate(
    goodCandidate({ topHolders: [{ percentage: 33 }, { percentage: 2 }] }),
    CONFIG,
    NOW
  );
  check(
    'a 33% holder is penalised, but less than a 55% one',
    moderateWhale.riskMultiplier > severeWhale.riskMultiplier &&
      moderateWhale.riskMultiplier < 1,
    `moderate ${moderateWhale.riskMultiplier} vs severe ${severeWhale.riskMultiplier}`
  );
  check(
    'a 33% holder still drops the candidate below the threshold',
    moderateWhale.score < CONFIG.minScore,
    `scored ${moderateWhale.score}`
  );

  // Risk 2: a free mint being claimed faster than any human crowd could is one
  // operator running scripts. This previously scored 93 — above the ideal case.
  const botFarm = scoreCandidate(
    goodCandidate({ mintPriceEth: 0, totalSupply: 500, mintsPerMinute: 40 }),
    CONFIG,
    NOW
  );
  eq('a fast free mint is scored, not hard-rejected', botFarm.rejected, null);
  check(
    'a fast free mint is filtered out',
    botFarm.score < CONFIG.minScore,
    `scored ${botFarm.score}, threshold ${CONFIG.minScore}`
  );
  check(
    'the bot-farming suspicion is stated',
    botFarm.reasons.some((r) => /RISK:.*bot farming/i.test(r)),
    JSON.stringify(botFarm.reasons)
  );

  // The same free mint at a human pace is a legitimate signal, so the penalty
  // must key on the rate rather than on the price being zero.
  const organicFree = scoreCandidate(
    goodCandidate({ mintPriceEth: 0, totalSupply: 500, mintsPerMinute: 8 }),
    CONFIG,
    NOW
  );
  eq('an organically-paced free mint takes no bot penalty', organicFree.riskMultiplier, 1);
  check(
    'an organically-paced free mint outscores the bot-farmed one',
    organicFree.score > botFarm.score,
    `organic ${organicFree.score} vs bots ${botFarm.score}`
  );

  // Risk 3: expensive plus unproven is the cash-grab shape. 1.5 ETH previously
  // scored 83 because the price decay ran all the way out to the 5 ETH ceiling.
  const cashGrab = scoreCandidate(
    goodCandidate({ mintPriceEth: 1.5, safelistStatus: 'not_requested', socials: {} }),
    CONFIG,
    NOW
  );
  check(
    'an expensive unverified mint is filtered out',
    cashGrab.score < CONFIG.minScore,
    `scored ${cashGrab.score}, threshold ${CONFIG.minScore}`
  );
  check(
    'the unverified-price risk is stated',
    cashGrab.reasons.some((r) => /RISK:.*unverified collection/i.test(r)),
    JSON.stringify(cashGrab.reasons)
  );

  // Overpricing alone should cost points without being disqualifying: an
  // established team can legitimately price a mint at 1.5 ETH.
  const pricyButKnown = scoreCandidate(goodCandidate({ mintPriceEth: 1.5 }), CONFIG, NOW);
  eq('an approved collection takes no unverified-price penalty', pricyButKnown.riskMultiplier, 1);
  check(
    'overpricing still costs points on its own',
    pricyButKnown.score < healthy.score,
    `pricy ${pricyButKnown.score} vs healthy ${healthy.score}`
  );

  // Penalties compound, so a candidate failing several ways lands far down.
  const multiFail = scoreCandidate(
    goodCandidate({
      safelistStatus: 'not_requested',
      socials: {},
      mintPriceEth: 1.5,
      topHolders: [{ percentage: 55 }, { percentage: 3 }],
    }),
    CONFIG,
    NOW
  );
  check(
    'multiple risks compound rather than cancelling out',
    multiFail.riskMultiplier < severeWhale.riskMultiplier,
    `combined ${multiFail.riskMultiplier} vs whale-only ${severeWhale.riskMultiplier}`
  );
  check(
    'a candidate failing several ways scores far below the threshold',
    multiFail.score < CONFIG.minScore / 2,
    `scored ${multiFail.score}`
  );

  // Risk thresholds must be honoured from config so /threshold-style tuning and
  // hand-edits to config.json actually take effect.
  const relaxed = { ...CONFIG, risk: { ...CONFIG.risk, severeTopHolderPenalty: 1 } };
  const unpenalised = scoreCandidate(
    goodCandidate({ topHolders: [{ percentage: 55 }, { percentage: 2 }] }),
    relaxed,
    NOW
  );
  check(
    'risk penalties are read from config, not hard-coded',
    unpenalised.score > severeWhale.score,
    `relaxed ${unpenalised.score} vs shipped ${severeWhale.score}`
  );
}

// --- Mint tracker ---------------------------------------------------------

{
  const tracker = new MintTracker({ windowMinutes: 10, minMints: 5, minUniqueMinters: 3 });
  const contract = '0xCONTRACT';

  for (let i = 0; i < 10; i++) {
    tracker.record({
      contractAddress: contract,
      toAddress: `0xminter${i}`,
      atMs: NOW - i * 10000, // one every 10s
      slug: 'tracked',
    });
  }

  const stats = tracker.stats(contract, NOW);
  eq('tracker counts mints in the window', stats.totalMints, 10);
  eq('tracker counts distinct minters', stats.uniqueMinters, 10);
  eq('tracker lowercases the contract address', stats.contractAddress, contract.toLowerCase());
  check('tracker computes a positive rate', stats.mintsPerMinute > 0, String(stats.mintsPerMinute));

  // Repeat minters must not inflate the unique count.
  const repeat = new MintTracker({ windowMinutes: 10, minMints: 1, minUniqueMinters: 1 });
  for (let i = 0; i < 20; i++) {
    repeat.record({ contractAddress: '0xself', toAddress: '0xsamewallet', atMs: NOW - i * 1000 });
  }
  const selfStats = repeat.stats('0xself', NOW);
  eq('20 mints from one wallet counts as 20 mints', selfStats.totalMints, 20);
  eq('20 mints from one wallet counts as 1 unique minter', selfStats.uniqueMinters, 1);

  // A rate must not be divided by the nominal window when the mint just started.
  const burst = new MintTracker({ windowMinutes: 10, minMints: 1, minUniqueMinters: 1 });
  for (let i = 0; i < 30; i++) {
    burst.record({ contractAddress: '0xburst', toAddress: `0xw${i}`, atMs: NOW - i * 1000 });
  }
  const burstStats = burst.stats('0xburst', NOW);
  check(
    'a 30-second burst reports a high rate, not one diluted by the window',
    burstStats.mintsPerMinute > 30,
    `${burstStats.mintsPerMinute}/min`
  );

  // Events older than the window must age out.
  const aging = new MintTracker({ windowMinutes: 5, minMints: 1, minUniqueMinters: 1 });
  aging.record({ contractAddress: '0xold', toAddress: '0xa', atMs: NOW - 60 * 60 * 1000 });
  eq('stale events are excluded from stats', aging.stats('0xold', NOW), null);
  aging.prune(NOW);
  eq('pruning removes contracts with no live events', aging.contracts.size, 0);

  // Threshold gating.
  const quiet = new MintTracker({ windowMinutes: 10, minMints: 50, minUniqueMinters: 40 });
  quiet.record({ contractAddress: '0xquiet', toAddress: '0xa', atMs: NOW });
  eq('a contract below thresholds is not hot', quiet.hot(NOW).length, 0);
  eq('a contract above thresholds is hot', tracker.hot(NOW).length, 1);
}

// --- Transfer event parsing ----------------------------------------------

{
  const mintEvent = {
    event_timestamp: '2026-08-22T11:59:00Z',
    from_account: { address: ZERO_ADDRESS },
    to_account: { address: '0xBUYER' },
    item: { nft_id: 'ethereum/0xdeadbeef/1234', metadata: { name: 'Token #1234' } },
    collection: { slug: 'some-collection' },
  };

  const parsed = parseTransferEvent(mintEvent);
  eq('contract address is extracted from nft_id', parsed.contractAddress, '0xdeadbeef');
  eq('from address is lowercased', parsed.fromAddress, ZERO_ADDRESS);
  eq('to address is lowercased', parsed.toAddress, '0xbuyer');
  eq('slug is carried through', parsed.slug, 'some-collection');
  eq('this event is recognised as a mint', isMintTransfer(parsed.fromAddress), true);
  eq('timestamp is parsed', parsed.atMs, Date.parse('2026-08-22T11:59:00Z'));

  // A secondary-market transfer is not a mint.
  const saleEvent = { ...mintEvent, from_account: { address: '0xseller' } };
  eq('a wallet-to-wallet transfer is not a mint', isMintTransfer(parseTransferEvent(saleEvent).fromAddress), false);

  // Flat string addresses instead of objects.
  const flat = parseTransferEvent({
    event_timestamp: '2026-08-22T11:59:00Z',
    from_account: ZERO_ADDRESS,
    to_account: '0xbuyer',
    item: { nft_id: 'ethereum/0xabc/1' },
  });
  eq('flat address strings are handled', flat.fromAddress, ZERO_ADDRESS);

  eq('an event with no contract is dropped', parseTransferEvent({ item: {} }), null);

  // A malformed timestamp must fall back rather than poison the window.
  const badTime = parseTransferEvent({
    event_timestamp: 'nonsense',
    from_account: { address: ZERO_ADDRESS },
    to_account: { address: '0xb' },
    item: { nft_id: 'ethereum/0xabc/1' },
  });
  check('a malformed timestamp falls back to now', Number.isFinite(badTime.atMs));
}

// --- Lead-time buckets ---------------------------------------------------

{
  const state = { alerted: {} };
  const contract = '0xdrop';
  const leadTimes = [180, 25];

  eq(
    'a mint 10 hours out triggers nothing yet',
    dueLeadBucket(NOW + 10 * HOUR, leadTimes, state, contract, NOW),
    null
  );

  const first = dueLeadBucket(NOW + 2 * HOUR, leadTimes, state, contract, NOW);
  eq('a mint 2 hours out fires the 180-minute heads-up', first, 180);

  markAlerted(state, contract, `upcoming-${first}`, new Date(NOW));
  eq(
    'the 180-minute heads-up does not fire twice',
    dueLeadBucket(NOW + 2 * HOUR, leadTimes, state, contract, NOW),
    null
  );

  const second = dueLeadBucket(NOW + 10 * 60 * 1000, leadTimes, state, contract, NOW);
  eq('closer in, the 25-minute get-ready ping fires', second, 25);

  markAlerted(state, contract, `upcoming-${second}`, new Date(NOW));
  eq(
    'both buckets spent means no further alerts',
    dueLeadBucket(NOW + 10 * 60 * 1000, leadTimes, state, contract, NOW),
    null
  );

  eq(
    'a mint that already started fires nothing',
    dueLeadBucket(NOW - HOUR, leadTimes, { alerted: {} }, '0xother', NOW),
    null
  );

  // A mint discovered inside the final window should still get one ping.
  eq(
    'a mint discovered 5 minutes out still pings once',
    dueLeadBucket(NOW + 5 * 60 * 1000, leadTimes, { alerted: {} }, '0xlate', NOW),
    25
  );
}

// --- State: dedupe and pruning ------------------------------------------

{
  const state = { alerted: {}, recent: [] };

  eq('nothing is alerted initially', wasAlerted(state, '0xabc', 'live'), false);
  markAlerted(state, '0xABC', 'live', new Date(NOW));
  eq('dedupe is case-insensitive on the address', wasAlerted(state, '0xabc', 'live'), true);
  eq('a different alert kind is tracked separately', wasAlerted(state, '0xabc', 'upcoming-25'), false);
  eq('dedupe keys are normalised', alertKey('0xAbC', 'live'), '0xabc|live');

  // Old entries must age out so the committed state file stays small.
  state.alerted['0xold|live'] = new Date(NOW - 60 * 24 * HOUR).toISOString();
  state.alerted['0xcorrupt|live'] = 'not-a-date';
  const removed = pruneState(state, 30, NOW);
  eq('pruning removes two stale entries', removed, 2);
  eq('the recent entry survives pruning', wasAlerted(state, '0xabc', 'live'), true);

  for (let i = 0; i < 40; i++) {
    recordRecent(state, { name: `Collection ${i}`, kind: 'live', score: 70 }, new Date(NOW));
  }
  eq('the recent list is capped at 25', state.recent.length, 25);
  eq('the newest alert is first', state.recent[0].name, 'Collection 39');
}

// --- State contains no secrets ------------------------------------------
//
// state.json is force-pushed to a PUBLIC branch on every run. Anything that ends
// up in it is world-readable forever. These two checks are the guard rail.

{
  const file = join(tmpdir(), `sniper-state-test-${process.pid}.json`);

  const state = loadState(file); // No such file: gives a pristine state.
  // A realistic 40-hex address, not a short fake one: contract addresses are
  // themselves long hex strings, and the secret-shaped check below has to
  // tolerate them or it would fire on every real state file.
  markAlerted(state, '0x1F98431c8aD98523631AE4a59f267346ea31F984', 'live', new Date(NOW));
  recordRecent(state, { name: 'Some Drop', kind: 'live', score: 82 }, new Date(NOW));
  state.telegramOffset = 918273645;
  state.overrides = { minScore: 80, paused: false };
  state.stats = { runs: 12, alertsSent: 3, lastRunAt: 'x', lastAlertAt: 'y' };
  state.apiKeyExpiresAt = '2026-08-29T00:00:00Z';
  saveState(file, state);

  const raw = readFileSync(file, 'utf8');
  const written = JSON.parse(raw);

  // An allowlist rather than a blocklist: adding any new field to the state
  // shape fails this check until someone has consciously decided it is safe to
  // publish. That is the point — the failure is the review prompt.
  const allowed = [
    'alerted',
    'apiKeyExpiresAt',
    'overrides',
    'recent',
    'stats',
    'telegramOffset',
    'version',
  ];
  const unexpected = Object.keys(written).filter((k) => !allowed.includes(k));
  eq('committed state has no fields outside the reviewed allowlist', unexpected.join(','), '');

  // Second guard: nothing that looks like a credential, whatever it is called.
  // Contract addresses are legitimately long hex, so drop 0x-prefixed tokens
  // before looking for a bare hex secret (an OpenSea key is 32 hex, no prefix).
  const withoutAddresses = raw.replace(/0x[0-9a-fA-F]+/g, '<address>');
  check(
    'committed state contains nothing shaped like a bot token',
    !/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/.test(raw),
    raw.slice(0, 300)
  );
  check(
    'committed state contains no bare hex secret',
    !/\b[0-9a-f]{32,}\b/i.test(withoutAddresses),
    withoutAddresses.slice(0, 300)
  );
  for (const word of ['token', 'apiKey', 'api_key', 'secret', 'password', 'privateKey']) {
    check(
      `committed state has no "${word}" field`,
      !new RegExp(`"${word}"\\s*:`, 'i').test(raw),
      raw.slice(0, 300)
    );
  }

  // And the guard has to actually be capable of firing, or it proves nothing.
  const poisoned = JSON.stringify({ ...written, openseaKey: 'a'.repeat(32) });
  check(
    'the secret guard would catch a leaked key',
    /\b[0-9a-f]{32,}\b/i.test(poisoned.replace(/0x[0-9a-fA-F]+/g, '<address>')),
    'guard is inert'
  );

  // And it must survive the round trip, since a broken reload means duplicate
  // alerts on every run.
  const reloaded = loadState(file);
  eq(
    'state round-trips through disk',
    wasAlerted(reloaded, '0x1F98431c8aD98523631AE4a59f267346ea31F984', 'live'),
    true
  );
  eq('the telegram cursor round-trips', reloaded.telegramOffset, 918273645);
  eq('overrides round-trip', reloaded.overrides.minScore, 80);

  rmSync(file, { force: true });
}

// --- Alert formatting ---------------------------------------------------

{
  const candidate = goodCandidate({
    kind: 'upcoming',
    startTimeMs: NOW + 2 * HOUR,
    leadBucketMinutes: 180,
    // A hostile collection name: Telegram HTML mode must not be broken by it.
    name: '<script>alert(1)</script> & "Friends"',
  });
  const result = scoreCandidate(candidate, CONFIG, NOW);
  const text = formatAlert(candidate, result, NOW);

  check('alert includes the score', text.includes(`${result.score}/100`));
  check('alert includes a countdown', /in 2h/.test(text), text.slice(0, 200));
  check('alert includes the mint price', text.includes('0.0300 ETH'), text.slice(0, 400));
  check('alert includes the per-wallet cap', text.includes('Max 2 per wallet'));
  check('alert includes an OpenSea link', text.includes('opensea.io/collection/healthy'));
  check('alert includes an Etherscan contract link', text.includes('etherscan.io/address/'));
  check('alert includes the disclaimer', /Not financial advice/.test(text));
  check('alert states how many signals were used', /Scored on \d\/6 signals/.test(text));

  check('raw script tags are escaped', !text.includes('<script>'), 'HTML injection via collection name');
  check('ampersands are escaped', text.includes('&amp;'));
  check('quotes survive as text', text.includes('Friends'));

  // Only tags we intentionally emit should be present.
  const tags = [...text.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1].toLowerCase());
  const allowed = new Set(['b', 'i', 'a', 'code']);
  const unexpected = [...new Set(tags)].filter((t) => !allowed.has(t));
  eq('no unexpected HTML tags are emitted', unexpected.join(','), '');

  const live = goodCandidate({ kind: 'live' });
  const liveText = formatAlert(live, scoreCandidate(live, CONFIG, NOW), NOW);
  check('live alerts are labelled as minting now', liveText.includes('MINTING NOW'));
  check('live alerts show the mint rate', /40\.0 mints\/min/.test(liveText), liveText.slice(0, 400));
  check('live alerts show the wallet count', /350 wallets/.test(liveText));

  const urgent = goodCandidate({ kind: 'upcoming', startTimeMs: NOW + 20 * 60 * 1000, leadBucketMinutes: 25 });
  const urgentText = formatAlert(urgent, scoreCandidate(urgent, CONFIG, NOW), NOW);
  check('the final-window alert is visually distinct', urgentText.includes('GET READY'));

  // A clean candidate must not grow an empty risk section.
  check('a clean alert has no risk section', !text.includes('Risk flags'));

  // Risk flags get their own block above the ordinary reasoning, because a
  // candidate that clears the threshold *despite* a warning is exactly the case
  // where the warning must not be bullet six of eight.
  const flagged = goodCandidate({ topHolders: [{ percentage: 33 }, { percentage: 2 }] });
  const flaggedText = formatAlert(flagged, scoreCandidate(flagged, CONFIG, NOW), NOW);
  check('risk flags get their own section', flaggedText.includes('Risk flags'), flaggedText.slice(0, 600));
  check(
    'risk flags appear above the ordinary reasoning',
    flaggedText.indexOf('Risk flags') < flaggedText.indexOf('Why this scored'),
    'risk section must come first'
  );
  check(
    'the RISK: prefix is stripped from the display text',
    !flaggedText.includes('RISK:'),
    flaggedText.slice(0, 600)
  );
  check(
    'the whale warning itself is rendered',
    /largest wallet holds 33%/.test(flaggedText),
    flaggedText.slice(0, 600)
  );

  // Thin-data alerts must say so, since a 3-signal score is weaker than a 6.
  const thin = goodCandidate({
    kind: 'upcoming',
    startTimeMs: NOW + 3 * HOUR,
    topHolders: [],
    totalMints: null,
    uniqueMinters: null,
    mintsPerMinute: null,
  });
  const thinText = formatAlert(thin, scoreCandidate(thin, CONFIG, NOW), NOW);
  check('thin-data alerts warn that the score is discounted', /thin data/.test(thinText), thinText.slice(0, 600));

  check('messages stay within the Telegram limit', text.length < 4000, `${text.length} chars`);
}

// --- API key minting happens once per run --------------------------------
{
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    // A failing key service used to be retried by every collector, which printed
    // "minting a temporary free key" three times per run when zero keys had been
    // minted. fetchFreeKey is stubbed so this stays offline.
    const failing = new OpenSeaClient({});
    let attempts = 0;
    failing.fetchFreeKey = async () => {
      attempts++;
      throw new OpenSeaError('simulated key service outage', 'KEY_FETCH_FAILED');
    };

    const errors = [];
    for (let i = 0; i < 3; i++) {
      await failing.ensureApiKey().catch((err) => errors.push(err));
    }

    eq('a failed key mint is attempted only once per run', attempts, 1);
    eq('the "minting a free key" warning prints once, not once per caller', warnings.length, 1);
    eq('every caller still sees the failure', errors.length, 3);
    check(
      'the cached failure is the same error, not a new attempt',
      errors.every((e) => e === errors[0]),
      'callers received different error objects'
    );

    // The success path must also mint once, no matter how many callers race.
    const working = new OpenSeaClient({});
    let mints = 0;
    working.fetchFreeKey = async () => {
      mints++;
      await new Promise((r) => setTimeout(r, 5));
      working.apiKey = 'key-from-mint';
      return { key: 'key-from-mint', expiresAt: null };
    };
    const keys = await Promise.all([working.ensureApiKey(), working.ensureApiKey(), working.ensureApiKey()]);
    eq('concurrent callers share a single key mint', mints, 1);
    check('all concurrent callers get the same key', keys.every((k) => k === 'key-from-mint'), keys.join(','));

    // A key supplied by the user must never trigger a mint.
    const supplied = new OpenSeaClient({ apiKey: 'permanent-key' });
    supplied.fetchFreeKey = async () => {
      throw new Error('must not be called when a key was supplied');
    };
    eq('a configured OPENSEA_API_KEY is used as-is', await supplied.ensureApiKey(), 'permanent-key');

    // Node's raw "fetch failed" tells the user nothing, so fetchFreeKey must
    // wrap it. Stub global fetch rather than the method, to exercise the real one.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    let wrapped = null;
    try {
      await new OpenSeaClient({}).fetchFreeKey();
    } catch (err) {
      wrapped = err;
    } finally {
      globalThis.fetch = realFetch;
    }
    check('a network failure while minting a key is wrapped, not left as "fetch failed"',
      wrapped instanceof OpenSeaError && wrapped.message !== 'fetch failed',
      String(wrapped && wrapped.message));
    check('the wrapped message tells the user what to do about it',
      /OPENSEA_API_KEY/.test(wrapped?.message ?? ''),
      String(wrapped && wrapped.message));
    eq('the wrapped error carries a usable code', wrapped?.code, 'KEY_FETCH_FAILED');
  } finally {
    console.warn = realWarn;
  }
}

// --- .env.example must never contain real credentials --------------------
{
  // `.env.example` is TRACKED; `.env` is not. They differ by one word, sit next
  // to each other, and hold the same keys — so filling in the wrong one is an
  // easy mistake with a permanent consequence on a public repo. This check makes
  // that mistake fail the build instead of leaking a live token.
  const examplePath = resolve(ROOT, '.env.example');
  const example = readFileSync(examplePath, 'utf8');

  /** Every KEY=VALUE pair, ignoring comments. */
  const assignments = example
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return i === -1 ? null : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    })
    .filter(Boolean);

  check('.env.example defines the credential keys', assignments.length >= 3, `${assignments.length} found`);

  const mustBeBlank = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'OPENSEA_API_KEY'];
  for (const key of mustBeBlank) {
    const entry = assignments.find((a) => a.key === key);
    check(`.env.example leaves ${key} blank`, entry !== undefined && entry.value === '',
      entry === undefined ? 'key missing entirely' : `has a value (${entry.value.length} chars)`);
  }

  // Shape checks, in case a future key is added and forgotten above.
  check('.env.example holds no Telegram-token-shaped string',
    !/\d{6,}:[A-Za-z0-9_-]{30,}/.test(example.replace(/^#.*$/gm, '')),
    'a real bot token appears to be filled in');
  check('.env.example holds no long opaque secret',
    !assignments.some((a) => /^[A-Za-z0-9_-]{24,}$/.test(a.value)),
    'a value looks like a real key');

  // The comment warning users off committing it must survive edits.
  check('.env.example still warns against committing a real .env',
    /never commit/i.test(example), 'the warning comment was removed');
}

// --- Report --------------------------------------------------------------

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.error(`${failures.length} FAILED:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All offline logic verified.\n');
