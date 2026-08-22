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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = {
  version: 1,
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
};

export function loadState(file) {
  if (!existsSync(file)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // Merge onto EMPTY so a state file written by an older version still works.
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      alerted: parsed.alerted ?? {},
      overrides: parsed.overrides ?? {},
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      stats: { ...EMPTY.stats, ...(parsed.stats ?? {}) },
    };
  } catch (err) {
    // A corrupt state file must not stop the bot: worst case we re-alert once.
    console.warn(`[state] ${file} unreadable (${err.message}); starting fresh.`);
    return structuredClone(EMPTY);
  }
}

export function saveState(file, state) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
