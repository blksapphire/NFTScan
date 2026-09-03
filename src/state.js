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
  research: { version: 1, alerts: [], snapshots: [], lastScan: { at: null, discovered: [], scored: [], meta: {} } },
};

function attachLastScanAlias(target, scan) {
  const value = scan ?? EMPTY.research.lastScan;
  Object.defineProperty(target, 'lastScan', {
    enumerable: false,
    configurable: true,
    get() { return this.research.lastScan; },
    set(next) { this.research.lastScan = next ?? value; },
  });
}

/** Normalize both fresh state and legacy v1 state before any caller touches it. */
export function normalizeState(parsed = {}) {
  const normalized = {
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
      lastScan: {
        ...EMPTY.research.lastScan,
        ...(parsed.research?.lastScan ?? parsed.lastScan ?? {}),
        discovered: Array.isArray(parsed.research?.lastScan?.discovered ?? parsed.lastScan?.discovered) ? (parsed.research?.lastScan?.discovered ?? parsed.lastScan.discovered) : [],
        scored: Array.isArray(parsed.research?.lastScan?.scored ?? parsed.lastScan?.scored) ? (parsed.research?.lastScan?.scored ?? parsed.lastScan.scored) : [],
        meta: (parsed.research?.lastScan?.meta ?? parsed.lastScan?.meta) ?? {},
      },
    },
  };
  delete normalized.lastScan;
  attachLastScanAlias(normalized);
  return normalized;
}

export function loadState(file) {
  if (!existsSync(file)) return normalizeState();
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn(`[state] ${file} unreadable (${err.message}); starting fresh.`);
    return normalizeState();
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
  const normalized = normalizeState(state);
  Object.assign(state, normalized);
  attachLastScanAlias(state);

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
  state.lastScan.scored = Array.isArray(state.lastScan.scored) ? state.lastScan.scored.slice(0, 200) : [];
  state.lastScan.discovered = Array.isArray(state.lastScan.discovered) ? state.lastScan.discovered.slice(0, 200) : [];
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
