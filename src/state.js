/**
 * State that has to survive between runs.
 *
 * GitHub Actions runners are destroyed after every run, so "have I already
 * alerted about this contract?" cannot live in memory. The workflow commits
 * this file to a dedicated `bot-state` branch between runs.
 *
 * This file is committed to a public repo, so it must never hold a secret.
 * The OpenSea key is the one sensitive-ish value and it stays in
 * GitHub Secrets; only its expiry date is recorded here.
 *
 * Version 2 adds a bounded outcome ledger. It deliberately stores observations,
 * not money or wallet credentials, so the scanner can measure whether its alerts
 * were actually useful without becoming an execution system.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = {
  version: 2,
  /** contractAddress|kind -> ISO timestamp we alerted. Prevents repeat pings. */
  alerted: {},
  /** Telegram getUpdates cursor, so we process each command exactly once. */
  telegramOffset: 0,
  /** Things you changed from Telegram: { minScore, paused }. */
  overrides: {},
  /** Rolling counters, for /status. */
  stats: { runs: 0, alertsSent: 0, lastRunAt: null, lastAlertAt: null },
  /** Newest-first log of recent alerts, for /recent. Capped. */
  recent: [],
  /** Non-secret note of when the auto-fetched OpenSea key expires. */
  apiKeyExpiresAt: null,
  /** Bounded alert-outcome ledger for research/backtesting. */
  outcomes: [],
};

export function loadState(file) {
  if (!existsSync(file)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // Merge onto EMPTY so a state file written by an older version still works.
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      version: 2,
      alerted: parsed.alerted ?? {},
      overrides: parsed.overrides ?? {},
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
      stats: { ...EMPTY.stats, ...(parsed.stats ?? {}) },
    };
  } catch (err) {
    // A corrupt state file must not stop the bot: worst case we re-alert once.
    console.warn(`[state] ${file} unreadable (${err.message}); starting fresh.`);
    return structuredClone(EMPTY);
  }
}

/**
 * Atomic state write. Writing a temporary file first prevents a killed runner
 * from leaving half-written JSON behind, which could otherwise cause a state
 * reset and duplicate alerts on the next run.
 */
export function saveState(file, state) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(temp, file);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort cleanup */
    }
  }
}

/**
 * Drop dedupe entries older than the retention window so the committed file
 * does not grow without bound.
 * @returns {number} how many entries were removed
 */
export function pruneState(state, dedupeDays, now = Date.now()) {
  const cutoff = now - dedupeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [key, iso] of Object.entries(state.alerted)) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || at < cutoff) {
      delete state.alerted[key];
      removed++;
    }
  }
  pruneOutcomes(state, Math.max(dedupeDays * 4, 90), now);
  return removed;
}

/** Dedupe key. `kind` separates a 3-hour heads-up from a 25-minute get-ready ping. */
export function alertKey(contractAddress, kind) {
  return `${String(contractAddress || 'unknown').toLowerCase()}|${kind}`;
}

export function wasAlerted(state, contractAddress, kind) {
  return Boolean(state.alerted[alertKey(contractAddress, kind)]);
}

export function markAlerted(state, contractAddress, kind, now = new Date()) {
  state.alerted[alertKey(contractAddress, kind)] = now.toISOString();
}

/** Keep the newest 25 alerts for /recent. Bounded so state stays small. */
export function recordRecent(state, entry, now = new Date()) {
  if (!Array.isArray(state.recent)) state.recent = [];
  state.recent.unshift({ ...entry, at: now.toISOString() });
  state.recent = state.recent.slice(0, 25);
}

/**
 * Start an outcome observation when an alert is sent.
 * The same contract/kind is updated rather than duplicated.
 */
export function startOutcome(state, alert, now = new Date()) {
  if (!Array.isArray(state.outcomes)) state.outcomes = [];
  const key = alertKey(alert.contractAddress, alert.kind || 'live');
  const existing = state.outcomes.find((o) => o.key === key);
  if (existing) return existing;

  const record = {
    key,
    contractAddress: String(alert.contractAddress || '').toLowerCase(),
    kind: alert.kind || 'live',
    name: alert.name || alert.slug || 'unknown',
    chain: alert.chain || 'ethereum',
    alertedAt: now.toISOString(),
    score: Number.isFinite(Number(alert.score)) ? Number(alert.score) : null,
    confidence: Number.isFinite(Number(alert.confidence)) ? Number(alert.confidence) : null,
    riskMultiplier: Number.isFinite(Number(alert.riskMultiplier)) ? Number(alert.riskMultiplier) : null,
    mintPriceEth: Number.isFinite(Number(alert.mintPriceEth)) ? Number(alert.mintPriceEth) : null,
    observations: [],
    closedAt: null,
  };

  state.outcomes.unshift(record);
  state.outcomes = state.outcomes.slice(0, 500);
  return record;
}

/** Append a point-in-time market observation to an outcome. */
export function recordOutcomeSnapshot(state, contractAddress, kind, snapshot, now = new Date()) {
  if (!Array.isArray(state.outcomes)) state.outcomes = [];
  const key = alertKey(contractAddress, kind || 'live');
  const record = state.outcomes.find((o) => o.key === key);
  if (!record) return null;

  const observation = {
    at: now.toISOString(),
    floorEth: finiteOrNull(snapshot?.floorEth),
    volumeEth: finiteOrNull(snapshot?.volumeEth),
    sales: finiteOrNull(snapshot?.sales),
    uniqueBuyers: finiteOrNull(snapshot?.uniqueBuyers),
    uniqueSellers: finiteOrNull(snapshot?.uniqueSellers),
    holders: finiteOrNull(snapshot?.holders),
    listingsPct: finiteOrNull(snapshot?.listingsPct),
  };

  record.observations.push(observation);
  // Keep the ledger bounded while preserving enough points for 5m/1h/6h/24h analysis.
  record.observations = record.observations.slice(-24);
  return observation;
}

export function finalizeOutcome(state, contractAddress, kind, now = new Date()) {
  const key = alertKey(contractAddress, kind || 'live');
  const record = state.outcomes?.find((o) => o.key === key);
  if (!record) return null;
  record.closedAt = now.toISOString();
  return record;
}

export function pruneOutcomes(state, retentionDays = 90, now = Date.now()) {
  if (!Array.isArray(state.outcomes)) {
    state.outcomes = [];
    return 0;
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const before = state.outcomes.length;
  state.outcomes = state.outcomes.filter((o) => {
    const at = Date.parse(o?.alertedAt);
    return Number.isFinite(at) && at >= cutoff;
  });
  return before - state.outcomes.length;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
