/** Generic contract-risk analyser for normalized ABI/collection metadata. */

const FLAGS = [
  ['canMint', 28, 'owner can mint additional supply'],
  ['canPause', 16, 'owner can pause transfers'],
  ['canBlacklist', 22, 'owner can blacklist addresses'],
  ['canChangeRoyalty', 8, 'royalty settings are mutable'],
  ['canChangeUri', 14, 'metadata URI is mutable'],
  ['upgradeable', 18, 'contract is upgradeable'],
  ['ownerCanWithdraw', 10, 'owner can withdraw funds'],
];

export function analyseContractRisk(meta = {}) {
  let score = 0;
  const reasons = [];
  const findings = [];
  for (const [key, points, reason] of FLAGS) {
    if (meta[key] === true) {
      score += points;
      findings.push(key);
      reasons.push(reason);
    }
  }
  if (meta.renouncedOwnership === true) score -= 12;
  if (meta.verifiedSource === true) score -= 8;
  if (meta.proxyImplementationVerified === true) score -= 5;
  if (meta.unknownOwner === true) score += 12;
  score = Math.max(0, Math.min(100, score));
  return { score, findings, reasons };
}

export function mergeContractRisk(candidate, meta) {
  const result = analyseContractRisk(meta);
  candidate.contractRisk = { ...result, checkedAt: new Date().toISOString() };
  return candidate.contractRisk;
}
