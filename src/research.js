/**
 * Research layer. Stores alert-time features and later market outcomes so
 * NFTScan can be calibrated from evidence instead of hand-tuned guesses.
 * No network and no external dependencies.
 */

const DEFAULT_HORIZONS = [5, 15, 60, 360, 1440];

export function createResearchState(existing = {}) {
  return {
    alerts: Array.isArray(existing.alerts) ? existing.alerts : [],
    snapshots: Array.isArray(existing.snapshots) ? existing.snapshots : [],
    version: Number(existing.version) || 1,
  };
}

export function recordAlert(state, candidate, result, nowMs = Date.now(), config = {}) {
  const research = createResearchState(state.research);
  const key = `${String(candidate.contractAddress || candidate.slug || 'unknown').toLowerCase()}|${candidate.alertKind || candidate.kind || 'alert'}|${nowMs}`;
  const entry = {
    id: key,
    at: new Date(nowMs).toISOString(),
    contractAddress: candidate.contractAddress || null,
    slug: candidate.slug || null,
    name: candidate.name || null,
    chain: candidate.chain || null,
    kind: candidate.kind || null,
    alertKind: candidate.alertKind || candidate.kind || null,
    score: Number(result.score) || 0,
    confidence: Number(result.confidence) || 0,
    riskScore: Number(result.riskScore) || 0,
    riskMultiplier: Number(result.riskMultiplier) || 1,
    coverage: Number(result.coverage) || 0,
    components: { ...(result.components || {}) },
    features: pickFeatures(candidate),
    outcomes: {},
    labelled: false,
  };
  research.alerts.unshift(entry);
  const max = Number(config.maxAlerts ?? config.research?.maxAlerts ?? 5000);
  research.alerts = research.alerts.slice(0, Math.max(100, max));
  state.research = research;
  return entry;
}

export function addOutcome(state, id, horizonMinutes, metrics = {}) {
  const research = createResearchState(state.research);
  const entry = research.alerts.find((a) => a.id === id);
  if (!entry) return false;
  entry.outcomes[String(horizonMinutes)] = {
    at: new Date().toISOString(),
    ...normaliseMetrics(metrics),
  };
  entry.labelled = true;
  state.research = research;
  return true;
}

export function addSnapshot(state, id, metrics = {}) {
  const research = createResearchState(state.research);
  if (!research.alerts.some((a) => a.id === id)) return false;
  research.snapshots.push({
    id,
    at: new Date().toISOString(),
    ...normaliseMetrics(metrics),
  });
  research.snapshots = research.snapshots.slice(-10000);
  state.research = research;
  return true;
}

export function buildBacktestReport(state, { horizonMinutes = 360, minScore = 0 } = {}) {
  const research = createResearchState(state.research);
  const rows = research.alerts.filter((a) => {
    if (Number(a.score) < Number(minScore)) return false;
    return Boolean(a.outcomes?.[String(horizonMinutes)]);
  });
  if (!rows.length) return emptyReport(horizonMinutes, minScore);

  const returns = rows.map((a) => Number(a.outcomes[String(horizonMinutes)].returnPct)).filter(Number.isFinite);
  const drawdowns = rows.map((a) => Number(a.outcomes[String(horizonMinutes)].drawdownPct)).filter(Number.isFinite);
  const wins = returns.filter((n) => n > 0).length;
  const buckets = bucketStats(rows, horizonMinutes);
  const featureImportance = empiricalFeatureImportance(rows, horizonMinutes);
  return {
    horizonMinutes,
    minScore,
    samples: rows.length,
    winRate: wins / Math.max(1, returns.length),
    medianReturnPct: median(returns),
    meanReturnPct: mean(returns),
    medianDrawdownPct: median(drawdowns),
    buckets,
    featureImportance,
  };
}

export function calibrateThresholds(state, options = {}) {
  const horizon = Number(options.horizonMinutes ?? 360);
  const rows = createResearchState(state.research).alerts
    .map((a) => ({ score: Number(a.score), outcome: Number(a.outcomes?.[String(horizon)]?.returnPct) }))
    .filter((x) => Number.isFinite(x.score) && Number.isFinite(x.outcome));
  const thresholds = [];
  for (let score = 50; score <= 95; score += 5) {
    const sample = rows.filter((x) => x.score >= score);
    if (!sample.length) continue;
    const positive = sample.filter((x) => x.outcome > 0).length;
    thresholds.push({ score, samples: sample.length, winRate: positive / sample.length, averageReturnPct: mean(sample.map((x) => x.outcome)) });
  }
  return thresholds;
}

function pickFeatures(candidate) {
  return {
    mintPriceEth: finite(candidate.mintPriceEth),
    totalSupply: finite(candidate.totalSupply),
    uniqueMinters: finite(candidate.uniqueMinters),
    totalMints: finite(candidate.totalMints),
    mintsPerMinute: finite(candidate.mintsPerMinute),
    previousMintsPerMinute: finite(candidate.previousMintsPerMinute),
    walletAgeMedianHours: finite(candidate.walletAgeMedianHours),
    walletPriorActivityRatio: finite(candidate.walletPriorActivityRatio),
    sharedFundingRatio: finite(candidate.sharedFundingRatio ?? candidate.walletQuality?.sharedFundingRatio),
    topHolderPct: topHolderPct(candidate.topHolders),
    safelistStatus: candidate.safelistStatus || null,
  };
}

function topHolderPct(holders) {
  if (!Array.isArray(holders) || !holders.length) return null;
  const p = holders.map((h) => Number(h?.percentage)).filter(Number.isFinite);
  if (!p.length) return null;
  const max = Math.max(...p);
  return max <= 1 ? max * 100 : max;
}

function normaliseMetrics(m) {
  return {
    floorEth: finite(m.floorEth),
    volumeEth: finite(m.volumeEth),
    listings: finite(m.listings),
    sales: finite(m.sales),
    uniqueBuyers: finite(m.uniqueBuyers),
    uniqueSellers: finite(m.uniqueSellers),
    returnPct: finite(m.returnPct),
    drawdownPct: finite(m.drawdownPct),
    maxFloorEth: finite(m.maxFloorEth),
  };
}

function empiricalFeatureImportance(rows, horizon) {
  const names = ['score', 'confidence', 'riskScore', 'uniqueMinterRatio', 'mintVelocity', 'mintAcceleration', 'holderConcentration', 'walletQuality'];
  const out = {};
  for (const name of names) {
    const pairs = rows.map((r) => {
      const value = name === 'score' ? r.score : name === 'confidence' ? r.confidence : name === 'riskScore' ? r.riskScore : r.components?.[name];
      const y = Number(r.outcomes?.[String(horizon)]?.returnPct);
      return [Number(value), y];
    }).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    out[name] = pairs.length < 3 ? 0 : Math.abs(correlation(pairs.map((p) => p[0]), pairs.map((p) => p[1])));
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function bucketStats(rows, horizon) {
  const ranges = [[50,59],[60,69],[70,79],[80,89],[90,100]];
  return ranges.map(([lo, hi]) => {
    const sample = rows.filter((a) => a.score >= lo && a.score <= hi);
    const returns = sample.map((a) => Number(a.outcomes[String(horizon)].returnPct)).filter(Number.isFinite);
    return { range: `${lo}-${hi}`, samples: sample.length, winRate: returns.length ? returns.filter((x) => x > 0).length / returns.length : 0, medianReturnPct: median(returns) };
  });
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  const am = mean(a), bm = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - am, y = b[i] - bm;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.max(Math.sqrt(da * db), 1e-12);
}

function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function emptyReport(horizonMinutes, minScore) { return { horizonMinutes, minScore, samples: 0, winRate: 0, medianReturnPct: null, meanReturnPct: null, medianDrawdownPct: null, buckets: [], featureImportance: {} }; }

export const DEFAULT_OUTCOME_HORIZONS = DEFAULT_HORIZONS;
