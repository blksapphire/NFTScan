/**
 * Cheap wallet-quality heuristics. This deliberately returns an estimate, not
 * a claim that an address belongs to a unique human.
 */

export function analyseWallets(wallets = [], options = {}) {
  const rows = Array.isArray(wallets) ? wallets.filter(Boolean) : [];
  if (!rows.length) return null;
  const freshHours = Number(options.freshWalletHours ?? 24);
  const sharedFundingWarningRatio = Number(options.sharedFundingWarningRatio ?? 0.35);

  const ages = rows.map((w) => Number(w.ageHours)).filter(Number.isFinite);
  const active = rows.filter((w) => Number(w.priorTransactions ?? w.priorActivity ?? 0) > 0);
  const funders = rows.map((w) => String(w.funder || w.fundingSource || '')).filter(Boolean);
  const counts = new Map();
  for (const f of funders) counts.set(f, (counts.get(f) || 0) + 1);
  const largestFundingCluster = counts.size ? Math.max(...counts.values()) : 0;
  const sharedFundingRatio = rows.length ? largestFundingCluster / rows.length : 0;
  const medianAge = median(ages);
  const priorActivityRatio = active.length / rows.length;
  const freshRatio = ages.length ? ages.filter((h) => h <= freshHours).length / ages.length : null;

  let score = 0;
  let weight = 0;
  if (Number.isFinite(medianAge)) { score += ramp(medianAge, 6, 168) * 0.35; weight += 0.35; }
  score += priorActivityRatio * 0.40; weight += 0.40;
  score += (1 - Math.min(1, sharedFundingRatio)) * 0.25; weight += 0.25;

  return {
    score: score / Math.max(weight, 1),
    walletCount: rows.length,
    walletAgeMedianHours: medianAge,
    walletPriorActivityRatio: priorActivityRatio,
    freshWalletRatio: freshRatio,
    sharedFundingRatio,
    warning: sharedFundingRatio >= sharedFundingWarningRatio,
  };
}

export function clusterFunding(wallets = []) {
  const map = new Map();
  for (const wallet of wallets) {
    const address = wallet.address || wallet.wallet;
    const funder = wallet.funder || wallet.fundingSource;
    if (!address || !funder) continue;
    const key = String(funder).toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(String(address).toLowerCase());
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length).map(([funder, addresses]) => ({ funder, addresses, size: addresses.length }));
}

function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function ramp(v, min, max) { return Math.min(1, Math.max(0, (Number(v) - min) / (max - min || 1))); }
