/** Durable state for both alerting and quantitative research. */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

const EMPTY = {
  version: 2,
  alerted: {},
  telegramOffset: 0,
  overrides: {},
  stats: { runs: 0, alertsSent: 0, lastRunAt: null, lastAlertAt: null },
  recent: [],
  apiKeyExpiresAt: null,
  research: { version: 1, alerts: [], snapshots: [] },
};

/** Normalize both fresh state and legacy v1 state before any caller touches it. */
export function normalizeState(parsed = {}) {
  return {
    ...structuredClone(EMPTY),
    ...parsed,
    version: Math.max(2, Number(parsed.version) || 1),
    alerted: parsed.alerted ?? {},
    overrides: parsed.overrides ?? {},
    recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    stats: { ...EMPTY.stats, ...(parsed.stats ?? {}) },
    research: {
      ...EMPTY.research,
      ...(parsed.research ?? {}),
      alerts: Array.isArray(parsed.research?.alerts) ? parsed.research.alerts : [],
      snapshots: Array.isArray(parsed.research?.snapshots) ? parsed.research.snapshots : [],
    },
  };
}

export function loadState(file) {
  if (!existsSync(file)) return structuredClone(EMPTY);
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn(`[state] ${file} unreadable (${err.message}); starting fresh.`);
    return structuredClone(EMPTY);
  }
}

/** Atomic replacement prevents a killed runner from leaving half-written JSON. */
export function saveState(file, state) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir || '.', `.state-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function pruneState(state, dedupeDays, now = Date.now(), researchRetentionDays = 90) {
  // pruneState is intentionally safe for callers/tests that pass an older
  // in-memory v1 state directly rather than going through loadState().
  const normalized = normalizeState(state);
  Object.assign(state, normalized);

  const cutoff = now - Number(dedupeDays) * 86400000;
  let removed = 0;
  for (const [key, iso] of Object.entries(state.alerted)) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || at < cutoff) {
      delete state.alerted[key];
      removed++;
    }
  }

  const researchCutoff = now - Number(researchRetentionDays) * 86400000;
  state.research.alerts = state.research.alerts.filter((a) => {
    const t = Date.parse(a.at);
    return !Number.isFinite(t) || t >= researchCutoff;
  }).slice(0, 5000);
  state.research.snapshots = state.research.snapshots.filter((a) => {
    const t = Date.parse(a.at);
    return !Number.isFinite(t) || t >= researchCutoff;
  }).slice(-10000);
  return removed;
}

export function alertKey(contractAddress, kind) {
  return `${String(contractAddress || 'unknown').toLowerCase()}|${kind}`;
}
export function wasAlerted(state, contractAddress, kind) { return Boolean(state.alerted[alertKey(contractAddress, kind)]); }
export function markAlerted(state, contractAddress, kind, now = new Date()) { state.alerted[alertKey(contractAddress, kind)] = now.toISOString(); }
export function recordRecent(state, entry, now = new Date()) {
  if (!Array.isArray(state.recent)) state.recent = [];
  state.recent.unshift({ ...entry, at: now.toISOString() });
  state.recent = state.recent.slice(0, 25);
}
