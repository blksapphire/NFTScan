/**
 * NFTScan quantitative screener.
 *
 * Pure and deterministic: no network, clock or state. The output deliberately
 * separates opportunity score, confidence and risk so the operator can see
 * whether a high score is actually well-supported.
 */

import { ramp, unit, hoursBetween } from './util.js';

export const COMPONENT_KEYS = [
  'uniqueMinterRatio',
  'mintVelocity',
  'mintAcceleration',
  'contractFreshness',
  'verification',
  'priceSanity',
  'holderConcentration',
  'walletQuality',
];

export function normalisePercentages(holders) {
  const raw = (holders || [])
    .map((h) => Number(h?.percentage))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!raw.length) return [];
  const max = Math.max(...raw);
  return max <= 1 ? raw.map((n) => n * 100) : raw;
}

export function scoreCandidate(candidate, config, nowMs = Date.now()) {
  const rejection = hardReject(candidate, config, nowMs);
  if (rejection) return rejected(rejection);

  const components = {};
  const reasons = [];
  computeDistribution(candidate, components, reasons);
  computeVelocity(candidate, components, reasons);
  computeAcceleration(candidate, components, reasons);
  computeFreshness(candidate, config, nowMs, components, reasons);
  computeVerification(candidate, components, reasons);
  computePrice(candidate, config, components, reasons);
  computeConcentration(candidate, components, reasons);
  computeWalletQuality(candidate, components, reasons);

  const configured = config.weights || {};
  let weighted = 0;
  let availableWeight = 0;
  const available = [];
  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    const weight = Number(configured[key] || 0);
    if (value === undefined || value === null || weight <= 0) continue;
    weighted += unit(value) * weight;
    availableWeight += weight;
    available.push(key);
  }
  if (!availableWeight) return { ...rejected('no scoreable signals available'), components, available, reasons };

  const coverage = unit(availableWeight / 100);
  const base = weighted / availableWeight;
  // Missing evidence is a confidence problem, not a reason to renormalise to 100%.
  const confidenceFloor = Number(config.confidence?.minimumMultiplier ?? 0.55);
  const confidence = confidenceFloor + (1 - confidenceFloor) * coverage;

  const { riskMultiplier, riskReasons, riskScore } = assessRisk(candidate, config);
  reasons.push(...riskReasons);
  const score = Math.round(base * confidence * riskMultiplier * 100);

  return {
    score,
    rejected: null,
    reasons,
    components,
    available,
    confidence,
    coverage,
    riskMultiplier,
    riskScore,
  };
}

function rejected(reason) {
  return {
    score: 0,
    rejected: reason,
    reasons: [],
    components: {},
    available: [],
    confidence: 0,
    coverage: 0,
    riskMultiplier: 1,
    riskScore: 100,
  };
}

function hardReject(candidate, config, nowMs) {
  const rules = config.hardRejects || {};
  const freshness = config.freshness || {};
  if (rules.requireContractAddress && !candidate.contractAddress) return 'no contract address';
  if (candidate.isDisabled) return 'collection disabled by OpenSea';
  if (candidate.isNsfw) return 'flagged NSFW';

  const price = candidate.mintPriceEth;
  if (price === 0 && Number.isFinite(candidate.totalSupply) && Number.isFinite(rules.rejectFreeMintsAboveSupply) && candidate.totalSupply > rules.rejectFreeMintsAboveSupply) {
    return `free mint with ${candidate.totalSupply} supply (spam airdrop pattern)`;
  }
  if (Number.isFinite(price) && Number.isFinite(rules.maxMintPriceEth) && price > rules.maxMintPriceEth) {
    return `mint price ${price} ETH above your ${rules.maxMintPriceEth} ETH ceiling`;
  }
  if (candidate.kind === 'upcoming') {
    if (!Number.isFinite(candidate.startTimeMs)) return 'no mint start time';
    if (rules.requireStageTimeInFuture && candidate.startTimeMs <= nowMs) return 'mint already started';
    if (Number.isFinite(freshness.maxDropLeadHours) && hoursBetween(candidate.startTimeMs, nowMs) > freshness.maxDropLeadHours) {
      return `mint is more than ${freshness.maxDropLeadHours}h away`;
    }
  }
  if (candidate.kind === 'new_collection') {
    if (!Number.isFinite(candidate.createdAtMs)) return 'no creation date';
    const ageHours = hoursBetween(nowMs, candidate.createdAtMs);
    if (Number.isFinite(freshness.maxCollectionAgeHours) && ageHours > freshness.maxCollectionAgeHours) return `collection is ${Math.round(ageHours)}h old, past your ${freshness.maxCollectionAgeHours}h window`;
  }
  return null;
}

function computeDistribution(candidate, components, reasons) {
  const u = Number(candidate.uniqueMinters);
  const m = Number(candidate.totalMints);
  if (!Number.isFinite(u) || !Number.isFinite(m) || m <= 0) return;
  const ratio = unit(u / m);
  components.uniqueMinterRatio = ramp(ratio, 0.25, 0.8);
  const pct = Math.round(ratio * 100);
  reasons.push(ratio >= 0.7 ? `Healthy mint spread: ${u} wallets / ${m} mints (${pct}%)` : ratio >= 0.4 ? `Mixed mint spread: ${u} wallets / ${m} mints (${pct}%)` : `Concentrated minting: ${u} wallets / ${m} mints (${pct}%) — possible self-minting`);
}

function computeVelocity(candidate, components, reasons) {
  const v = Number(candidate.mintsPerMinute);
  const s = Number(candidate.totalSupply);
  if (!Number.isFinite(v) || v <= 0) return;
  if (Number.isFinite(s) && s > 0) {
    const fraction = v / s;
    components.mintVelocity = ramp(fraction, 0.0005, 0.02);
    const sellout = Math.round(s / v);
    reasons.push(`Minting ${v.toFixed(1)}/min of ${s} — projected sellout ~${formatMinutes(sellout)}`);
  } else {
    components.mintVelocity = ramp(v, 1, 50);
    reasons.push(`Minting ${v.toFixed(1)}/min (supply unknown)`);
  }
}

function computeAcceleration(candidate, components, reasons) {
  const current = Number(candidate.mintsPerMinute);
  const previous = Number(candidate.previousMintsPerMinute ?? candidate.mintsPerMinute5mAgo);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return;
  const acceleration = (current - previous) / previous;
  components.mintAcceleration = ramp(acceleration, -0.25, 0.75);
  if (acceleration >= 0.25) reasons.push(`Demand accelerating: ${Math.round(acceleration * 100)}% faster than the previous window`);
  else if (acceleration <= -0.25) reasons.push(`Demand decelerating: ${Math.round(Math.abs(acceleration) * 100)}% below the previous window`);
}

function computeFreshness(candidate, config, nowMs, components, reasons) {
  if (candidate.kind === 'upcoming') { components.contractFreshness = 1; return; }
  if (!Number.isFinite(candidate.createdAtMs)) return;
  const maxAge = Number(config.freshness?.maxCollectionAgeHours) || 72;
  const ageHours = hoursBetween(nowMs, candidate.createdAtMs);
  components.contractFreshness = 1 - ramp(ageHours, 0, maxAge);
  reasons.push(ageHours < 1 ? 'Created less than an hour ago' : `Created ${Math.round(ageHours)}h ago`);
}

function computeVerification(candidate, components, reasons) {
  const status = String(candidate.safelistStatus || '').toLowerCase();
  const statusScore = status === 'verified' ? 1 : status === 'approved' ? 0.85 : status === 'requested' ? 0.45 : 0.1;
  const socials = candidate.socials || {};
  const count = ['twitter', 'discord', 'telegram', 'website'].filter((k) => socials[k]).length;
  components.verification = unit(statusScore * 0.6 + ramp(count, 0, 3) * 0.4);
  if (status) reasons.push(`OpenSea status: ${status}`);
  reasons.push(count ? `Socials present: ${count}/4` : 'No socials listed — team cannot be independently verified');
}

function computePrice(candidate, config, components, reasons) {
  const p = Number(candidate.mintPriceEth);
  if (!Number.isFinite(p)) return;
  const min = Number(config.priceSanity?.idealMinEth ?? 0.005);
  const max = Number(config.priceSanity?.idealMaxEth ?? 0.15);
  const decay = Number(config.priceSanity?.decayToZeroEth ?? 1);
  if (p === 0) components.priceSanity = 0.25;
  else if (p >= min && p <= max) components.priceSanity = 1;
  else if (p < min) components.priceSanity = 0.5 + 0.5 * ramp(p, 0, min);
  else { components.priceSanity = 1 - ramp(p, max, Math.max(decay, max + 0.01)); reasons.push(`Mint price ${p} ETH is above the ${max} ETH sweet spot`); }
}

function computeConcentration(candidate, components, reasons) {
  const percentages = normalisePercentages(candidate.topHolders);
  if (!percentages.length) return;
  const sorted = [...percentages].sort((a, b) => b - a);
  const top1 = sorted[0];
  const top10 = sorted.slice(0, 10).reduce((a, b) => a + b, 0);
  components.holderConcentration = unit(1 - ramp(top10, 20, 70));
  if (top1 >= 30) components.holderConcentration = Math.min(components.holderConcentration, top1 >= 50 ? 0.05 : 0.2);
  reasons.push(`Ownership: top ${Math.min(10, sorted.length)} wallets hold ${Math.round(top10)}%; largest ${Math.round(top1)}%`);
}

function computeWalletQuality(candidate, components, reasons) {
  const q = candidate.walletQuality;
  if (q && Number.isFinite(Number(q.score))) {
    components.walletQuality = unit(Number(q.score));
    reasons.push(`Wallet quality: ${Math.round(Number(q.score) * 100)}% organic estimate`);
    if (Number.isFinite(Number(q.sharedFundingRatio)) && Number(q.sharedFundingRatio) > 0.35) reasons.push(`Wallet cluster warning: ${Math.round(Number(q.sharedFundingRatio) * 100)}% share a funding source`);
    return;
  }
  const age = Number(candidate.walletAgeMedianHours);
  const prior = Number(candidate.walletPriorActivityRatio);
  const funding = Number(candidate.sharedFundingRatio);
  const seen = [age, prior, funding].filter(Number.isFinite);
  if (!seen.length) return;
  let score = 0;
  let weight = 0;
  if (Number.isFinite(age)) { score += ramp(age, 6, 168) * 0.35; weight += 0.35; }
  if (Number.isFinite(prior)) { score += prior * 0.4; weight += 0.4; }
  if (Number.isFinite(funding)) { score += (1 - funding) * 0.25; weight += 0.25; }
  components.walletQuality = unit(score / Math.max(weight, 1));
  reasons.push(`Wallet quality estimate: ${Math.round(components.walletQuality * 100)}%`);
}

function assessRisk(candidate, config) {
  const risk = config.risk || {};
  const pct = normalisePercentages(candidate.topHolders);
  const top1 = pct.length ? Math.max(...pct) : null;
  let multiplier = 1;
  let riskScore = 0;
  const reasons = [];

  if (top1 !== null) {
    if (top1 >= Number(risk.severeTopHolderPct ?? 50)) { multiplier *= Number(risk.severeTopHolderPenalty ?? 0.35); riskScore += 55; reasons.push(`RISK: one wallet controls ${Math.round(top1)}% of supply`); }
    else if (top1 >= Number(risk.highTopHolderPct ?? 30)) { multiplier *= Number(risk.highTopHolderPenalty ?? 0.65); riskScore += 30; reasons.push(`RISK: largest wallet controls ${Math.round(top1)}% of supply`); }
  }
  const velocity = Number(candidate.mintsPerMinute);
  if (candidate.mintPriceEth === 0 && Number.isFinite(velocity) && velocity > Number(risk.freeMintBotRatePerMin ?? 30)) { multiplier *= Number(risk.freeMintBotPenalty ?? 0.7); riskScore += 25; reasons.push(`RISK: free mint at ${velocity.toFixed(0)}/min resembles bot farming`); }
  const status = String(candidate.safelistStatus || '').toLowerCase();
  if (!['verified', 'approved'].includes(status) && Number(candidate.mintPriceEth) >= Number(risk.unverifiedPriceEth ?? 0.5)) { multiplier *= Number(risk.unverifiedPricePenalty ?? 0.7); riskScore += 20; reasons.push(`RISK: expensive unverified mint (${candidate.mintPriceEth} ETH)`); }
  if (candidate.walletQuality?.sharedFundingRatio >= 0.5) { multiplier *= 0.7; riskScore += 35; reasons.push(`RISK: strong shared-funding wallet cluster`); }
  const contract = candidate.contractRisk;
  if (contract) {
    const c = Number(contract.score);
    if (Number.isFinite(c)) { riskScore += c * 0.5; if (c >= 70) multiplier *= 0.55; else if (c >= 40) multiplier *= 0.8; reasons.push(`Contract risk score: ${Math.round(c)}/100`); }
  }
  return { riskMultiplier: unit(multiplier), riskScore: Math.min(100, Math.round(riskScore)), riskReasons: reasons };
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
