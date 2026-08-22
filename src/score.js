/**
 * The screener.
 *
 * Deliberately a pure function: no network, no clock of its own, no state.
 * That makes it the one part of this bot that can be tested exhaustively
 * offline, which matters because a scoring bug is the failure mode that
 * actually costs money.
 *
 * Three stages, the same way you'd screen a currency pair:
 *   1. Hard rejects  - binary disqualifiers, cheap, run first
 *   2. Weighted score - 0..100 across six components, each with a stated reason
 *   3. Confidence and risk - two multipliers applied to that score
 *
 * On stage 3, because both exist to fix real miscalibrations:
 *
 * CONFIDENCE. Not every component is available for every candidate. An upcoming
 * drop has no mint velocity yet; a poll-mode run has no unique-minter count
 * because that requires watching transfers in real time. So the weights are
 * RENORMALISED over the components actually present — otherwise poll-mode scores
 * would sit systematically below stream-mode scores and `minScore: 70` would
 * silently mean two different things depending on how you host the bot.
 *
 * But renormalising *alone* is perverse: drop a component that was scoring badly
 * and the average of what remains goes UP. Measured on real fixtures, a poll-mode
 * candidate scored 96 while the identical collection with full data scored 85 —
 * ignorance was outscoring quality. So the renormalised score is discounted by
 * how much of the total weight was actually observed.
 *
 * RISK. Some findings are not "slightly worse on average", they are reasons to
 * walk away. As a 10%-weight additive component, one wallet holding 55% of supply
 * moved a candidate from 85 to 75 — still above threshold, still alerted. Those
 * findings multiply instead, so they can genuinely veto.
 */

import { ramp, unit, hoursBetween } from './util.js';

/** Component keys, matching the `weights` block in config.json. */
export const COMPONENT_KEYS = [
  'uniqueMinterRatio',
  'mintVelocity',
  'contractFreshness',
  'verification',
  'priceSanity',
  'holderConcentration',
];

/**
 * Holder percentages are documented as "ownership percentage" floats without
 * specifying 0-1 or 0-100. Detect which by looking at the magnitudes: a top
 * holder above 1.0 can only be a percent value.
 * @param {Array<{percentage?: number}>} holders
 * @returns {number[]} percentages normalised to 0-100
 */
export function normalisePercentages(holders) {
  const raw = (holders || [])
    .map((h) => Number(h?.percentage))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (raw.length === 0) return [];
  const max = Math.max(...raw);
  // If every value is <= 1 the API is giving fractions, so scale up.
  return max <= 1 ? raw.map((n) => n * 100) : raw;
}

/**
 * @param {object} candidate  see buildCandidate() in sources.js
 * @param {object} config     loaded config.json
 * @param {number} nowMs
 * @returns {{score: number, rejected: string|null, reasons: string[], components: object, available: string[], confidence: number, riskMultiplier: number}}
 */
export function scoreCandidate(candidate, config, nowMs = Date.now()) {
  const rejection = hardReject(candidate, config, nowMs);
  if (rejection) {
    return {
      score: 0,
      rejected: rejection,
      reasons: [],
      components: {},
      available: [],
      confidence: 0,
      riskMultiplier: 1,
    };
  }

  const components = {};
  const reasons = [];

  computeDistribution(candidate, components, reasons);
  computeVelocity(candidate, components, reasons);
  computeFreshness(candidate, config, nowMs, components, reasons);
  computeVerification(candidate, components, reasons);
  computePriceSanity(candidate, config, components, reasons);
  computeConcentration(candidate, components, reasons);

  const weights = config.weights || {};
  let weighted = 0;
  let availableWeight = 0;
  const available = [];

  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    if (value === undefined || value === null) continue;
    const weight = Number(weights[key] || 0);
    if (weight <= 0) continue;
    weighted += unit(value) * weight;
    availableWeight += weight;
    available.push(key);
  }

  if (availableWeight === 0) {
    return {
      score: 0,
      rejected: 'no scoreable signals available',
      reasons,
      components,
      available,
      confidence: 0,
      riskMultiplier: 1,
    };
  }

  // Renormalise so poll mode and stream mode share one scale.
  const base = weighted / availableWeight;

  // But renormalising alone lets MISSING data raise a score: drop a weak
  // component and the average of what remains goes up. So discount by how much
  // of the weight we actually observed. Full coverage is unaffected; a
  // three-signal score is held slightly below what six signals could earn.
  const coverage = availableWeight / 100;
  const confidence = 0.75 + 0.25 * unit(coverage);

  // Some risks are not "a bit worse on average" — they are reasons to walk away.
  // Additive components cannot express that at 10% weight, so they multiply.
  const { riskMultiplier, riskReasons } = assessRisk(candidate, config);
  reasons.push(...riskReasons);

  const score = Math.round(base * confidence * riskMultiplier * 100);

  return {
    score,
    rejected: null,
    reasons,
    components,
    available,
    confidence,
    riskMultiplier,
  };
}

/**
 * Multiplicative penalties for the failure modes that should override an
 * otherwise good score. Each one states itself in the alert, so a suppressed
 * collection is explainable rather than silently missing.
 *
 * These multiply rather than add because "one wallet owns half the supply" is
 * not a signal that should be averaged against five good ones — as a 10%-weight
 * component it only moved a strong candidate from 85 to 75, which still alerted.
 */
function assessRisk(candidate, config) {
  const risk = config.risk || {};
  let riskMultiplier = 1;
  const riskReasons = [];

  const percentages = normalisePercentages(candidate.topHolders);
  const top1 = percentages.length ? Math.max(...percentages) : null;

  const severePct = Number(risk.severeTopHolderPct ?? 50);
  const highPct = Number(risk.highTopHolderPct ?? 30);

  if (top1 !== null && top1 >= severePct) {
    riskMultiplier *= Number(risk.severeTopHolderPenalty ?? 0.45);
    riskReasons.push(
      `RISK: one wallet holds ${Math.round(top1)}% of supply and could dump it all at once`
    );
  } else if (top1 !== null && top1 >= highPct) {
    riskMultiplier *= Number(risk.highTopHolderPenalty ?? 0.7);
    riskReasons.push(`RISK: largest wallet holds ${Math.round(top1)}% of supply`);
  }

  // Free mint plus very high throughput is the bot-farm signature: thousands of
  // scripted claims that evaporate the moment there is a real bid.
  const velocity = candidate.mintsPerMinute;
  const botRate = Number(risk.freeMintBotRatePerMin ?? 30);
  if (candidate.mintPriceEth === 0 && Number.isFinite(velocity) && velocity > botRate) {
    riskMultiplier *= Number(risk.freeMintBotPenalty ?? 0.75);
    riskReasons.push(
      `RISK: free mint claimed at ${velocity.toFixed(0)}/min — typical of bot farming, not demand`
    );
  }

  // Expensive AND unproven is the cash-grab shape.
  const status = String(candidate.safelistStatus || '').toLowerCase();
  const unproven = status !== 'verified' && status !== 'approved';
  const pricyEth = Number(risk.unverifiedPriceEth ?? 0.5);
  if (unproven && Number.isFinite(candidate.mintPriceEth) && candidate.mintPriceEth >= pricyEth) {
    riskMultiplier *= Number(risk.unverifiedPricePenalty ?? 0.7);
    riskReasons.push(`RISK: ${candidate.mintPriceEth} ETH mint from an unverified collection`);
  }

  return { riskMultiplier, riskReasons };
}

// --- Stage 1: hard rejects -------------------------------------------------

function hardReject(candidate, config, nowMs) {
  const rules = config.hardRejects || {};
  const freshness = config.freshness || {};

  if (rules.requireContractAddress && !candidate.contractAddress) {
    return 'no contract address';
  }

  // OpenSea's own moderation flags. Cheapest, strongest spam signal available.
  if (candidate.isDisabled) return 'collection disabled by OpenSea';
  if (candidate.isNsfw) return 'flagged NSFW';

  const price = candidate.mintPriceEth;

  if (
    price === 0 &&
    Number.isFinite(candidate.totalSupply) &&
    Number.isFinite(rules.rejectFreeMintsAboveSupply) &&
    candidate.totalSupply > rules.rejectFreeMintsAboveSupply
  ) {
    return `free mint with ${candidate.totalSupply} supply (spam airdrop pattern)`;
  }

  if (
    Number.isFinite(price) &&
    Number.isFinite(rules.maxMintPriceEth) &&
    price > rules.maxMintPriceEth
  ) {
    return `mint price ${price} ETH above your ${rules.maxMintPriceEth} ETH ceiling`;
  }

  if (candidate.kind === 'upcoming') {
    if (!Number.isFinite(candidate.startTimeMs)) return 'no mint start time';
    if (rules.requireStageTimeInFuture && candidate.startTimeMs <= nowMs) {
      return 'mint already started';
    }
    if (
      Number.isFinite(freshness.maxDropLeadHours) &&
      hoursBetween(candidate.startTimeMs, nowMs) > freshness.maxDropLeadHours
    ) {
      return `mint is more than ${freshness.maxDropLeadHours}h away`;
    }
  }

  if (candidate.kind === 'new_collection') {
    if (!Number.isFinite(candidate.createdAtMs)) return 'no creation date';
    const ageHours = hoursBetween(nowMs, candidate.createdAtMs);
    if (
      Number.isFinite(freshness.maxCollectionAgeHours) &&
      ageHours > freshness.maxCollectionAgeHours
    ) {
      return `collection is ${Math.round(ageHours)}h old, past your ${freshness.maxCollectionAgeHours}h window`;
    }
  }

  return null;
}

// --- Stage 2: weighted components -----------------------------------------

/**
 * Unique minters divided by total mints. The heaviest weight, because it is the
 * best cheap wash-mint tell: a ratio near 1 means many separate wallets wanted
 * in, while a ratio near 0 means one entity minting to itself to manufacture
 * the appearance of demand.
 */
function computeDistribution(candidate, components, reasons) {
  const { uniqueMinters, totalMints } = candidate;
  if (!Number.isFinite(uniqueMinters) || !Number.isFinite(totalMints) || totalMints <= 0) {
    return; // Unavailable in poll mode; renormalisation handles it.
  }

  const ratio = uniqueMinters / totalMints;
  components.uniqueMinterRatio = ramp(ratio, 0.25, 0.75);

  const pct = Math.round(ratio * 100);
  if (ratio >= 0.7) {
    reasons.push(`Healthy spread: ${uniqueMinters} wallets across ${totalMints} mints (${pct}%)`);
  } else if (ratio >= 0.4) {
    reasons.push(`Mixed spread: ${uniqueMinters} wallets across ${totalMints} mints (${pct}%)`);
  } else {
    reasons.push(
      `Concentrated minting: only ${uniqueMinters} wallets for ${totalMints} mints (${pct}%) — possible self-minting`
    );
  }
}

/**
 * How fast it is selling, expressed against supply so a 500-piece and a
 * 10,000-piece collection are comparable.
 */
function computeVelocity(candidate, components, reasons) {
  const { mintsPerMinute, totalSupply } = candidate;
  if (!Number.isFinite(mintsPerMinute) || mintsPerMinute <= 0) return;

  if (Number.isFinite(totalSupply) && totalSupply > 0) {
    const fractionPerMinute = mintsPerMinute / totalSupply;
    components.mintVelocity = ramp(fractionPerMinute, 0.0005, 0.02);
    const minutesToSellOut = Math.round(totalSupply / mintsPerMinute);
    reasons.push(
      `Minting ${mintsPerMinute.toFixed(1)}/min of ${totalSupply} — sells out in ~${formatMinutes(minutesToSellOut)} at this pace`
    );
  } else {
    components.mintVelocity = ramp(mintsPerMinute, 1, 50);
    reasons.push(`Minting ${mintsPerMinute.toFixed(1)}/min (supply unknown)`);
  }
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Earlier is better. An upcoming drop is maximally early by definition. */
function computeFreshness(candidate, config, nowMs, components, reasons) {
  if (candidate.kind === 'upcoming') {
    components.contractFreshness = 1;
    return;
  }

  if (!Number.isFinite(candidate.createdAtMs)) return;

  const maxAge = Number(config.freshness?.maxCollectionAgeHours) || 72;
  const ageHours = hoursBetween(nowMs, candidate.createdAtMs);
  // Full marks at zero hours old, decaying to zero at the window edge.
  components.contractFreshness = 1 - ramp(ageHours, 0, maxAge);

  reasons.push(
    ageHours < 1
      ? `Created less than an hour ago`
      : `Created ${Math.round(ageHours)}h ago`
  );
}

/**
 * A proxy for "is there a real team here". Weighted modestly on purpose:
 * genuinely new collections have not had time to be verified, so leaning on
 * this too hard would filter out exactly the early entries you want.
 */
function computeVerification(candidate, components, reasons) {
  const status = String(candidate.safelistStatus || '').toLowerCase();

  const statusScore =
    status === 'verified' ? 1
    : status === 'approved' ? 0.8
    : status === 'requested' ? 0.4
    : status === 'not_requested' ? 0.15
    : 0.15; // unknown or absent: treat as unverified rather than as bad

  const socials = candidate.socials || {};
  const present = ['twitter', 'discord', 'telegram', 'website'].filter((k) => socials[k]);
  const socialScore = unit(present.length / 3);

  components.verification = unit(statusScore * 0.6 + socialScore * 0.4);

  if (status === 'verified' || status === 'approved') {
    reasons.push(`OpenSea status: ${status}`);
  }
  if (present.length) {
    reasons.push(`Socials: ${present.join(', ')}`);
  } else {
    reasons.push(`No socials listed — cannot verify a team exists`);
  }
}

/**
 * Both extremes are warning signs: free mints attract bots and airdrop spam,
 * while a very high mint price on an unproven project is a cash grab.
 */
function computePriceSanity(candidate, config, components, reasons) {
  const price = candidate.mintPriceEth;
  if (!Number.isFinite(price)) return;

  const idealMin = Number(config.priceSanity?.idealMinEth ?? 0.005);
  const idealMax = Number(config.priceSanity?.idealMaxEth ?? 0.15);
  // Decay to zero here rather than at the hard-reject ceiling. Using the ceiling
  // made the decay so gradual that a 1.5 ETH mint still scored 0.72, which is
  // not what "above the sweet spot" should feel like.
  const decayEnd = Number(config.priceSanity?.decayToZeroEth ?? 1);

  if (price === 0) {
    components.priceSanity = 0.25;
    reasons.push(`Free mint — low risk to enter, but bot-heavy and often low value`);
    return;
  }

  if (price >= idealMin && price <= idealMax) {
    components.priceSanity = 1;
  } else if (price < idealMin) {
    // Cheap but not free: partial credit, scaled by how close to the band.
    components.priceSanity = 0.5 + 0.5 * ramp(price, 0, idealMin);
  } else {
    components.priceSanity = 1 - ramp(price, idealMax, Math.max(decayEnd, idealMax + 0.01));
    reasons.push(`Mint price ${price} ETH is above the ${idealMax} ETH sweet spot`);
  }
}

/**
 * Top-wallet share, as a rug proxy. If a handful of wallets hold most of the
 * supply they can dump into your bid.
 */
function computeConcentration(candidate, components, reasons) {
  const percentages = normalisePercentages(candidate.topHolders);
  if (percentages.length === 0) return;

  const sorted = [...percentages].sort((a, b) => b - a);
  const top1 = sorted[0];
  const topNSum = Math.min(100, sorted.reduce((a, b) => a + b, 0));

  // <=20% held by the top wallets is healthy; >=70% is dangerous.
  let value = 1 - ramp(topNSum, 20, 70);

  // A single dominant wallet is worse than the same total spread over ten.
  if (top1 >= 30) value = Math.min(value, 0.2);
  else if (top1 >= 15) value = Math.min(value, 0.6);

  components.holderConcentration = unit(value);

  if (topNSum >= 60 || top1 >= 30) {
    reasons.push(
      `Concentrated ownership: top ${sorted.length} wallets hold ${Math.round(topNSum)}% (largest ${Math.round(top1)}%)`
    );
  } else {
    reasons.push(
      `Ownership spread: top ${sorted.length} wallets hold ${Math.round(topNSum)}%`
    );
  }
}
