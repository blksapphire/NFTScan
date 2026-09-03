import { strict as assert } from 'node:assert';
import { scoreCandidate, normalisePercentages } from '../src/score.js';
import { createResearchState, recordAlert, addOutcome, buildBacktestReport, calibrateThresholds } from '../src/research.js';
import { analyseWallets } from '../src/wallets.js';
import { analyseContractRisk } from '../src/contractRisk.js';
import { analyseMarket, outcomeFromMint } from '../src/market.js';
import { normalizeState, pruneState } from '../src/state.js';

const config = {
  minScore: 70,
  weights: { uniqueMinterRatio: 23, mintVelocity: 15, mintAcceleration: 12, contractFreshness: 12, verification: 10, priceSanity: 8, holderConcentration: 10, walletQuality: 10 },
  confidence: { minimumMultiplier: 0.60 },
  freshness: { maxDropLeadHours: 168, maxCollectionAgeHours: 72 },
  hardRejects: { requireContractAddress: true, rejectFreeMintsAboveSupply: 10000, maxMintPriceEth: 5, requireStageTimeInFuture: true },
  priceSanity: { idealMinEth: 0.005, idealMaxEth: 0.15, decayToZeroEth: 1 },
  risk: { severeTopHolderPct: 50, severeTopHolderPenalty: 0.35, highTopHolderPct: 30, highTopHolderPenalty: 0.65, freeMintBotRatePerMin: 30, freeMintBotPenalty: 0.7, unverifiedPriceEth: 0.5, unverifiedPricePenalty: 0.7 }
};
const now = Date.parse('2026-08-24T08:00:00Z');
const base = {
  kind:'live', chain:'ethereum', contractAddress:'0xabc', name:'Test', mintPriceEth:0.03, totalSupply:5000,
  createdAtMs:now-2*3600000, safelistStatus:'approved', socials:{twitter:'x',discord:'x'}, totalMints:400,
  uniqueMinters:350, mintsPerMinute:40, previousMintsPerMinute:25, topHolders:[{percentage:0.02},{percentage:0.01}],
  walletQuality:{score:0.9, sharedFundingRatio:0.05}
};
const good = scoreCandidate(base, config, now);
assert.equal(good.rejected, null);
assert.equal(good.available.length, 8);
assert(good.score >= 70);
const wash = scoreCandidate({...base, uniqueMinters:4}, config, now);
assert(wash.score < good.score);
const whale = scoreCandidate({...base, topHolders:[{percentage:0.55},{percentage:0.1}]}, config, now);
assert(whale.score < good.score);
assert(normalisePercentages([{percentage:0.4}])[0] === 40);

const wallets = analyseWallets([{ageHours:2, priorTransactions:0, funder:'A'},{ageHours:200, priorTransactions:20, funder:'B'},{ageHours:400, priorTransactions:30, funder:'B'}]);
assert(wallets && wallets.sharedFundingRatio > 0.5);
assert(analyseContractRisk({ canMint:true, canBlacklist:true, upgradeable:true }).score > 50);
assert(analyseMarket({ floorEth:0.05, volumeEth:10, listings:100, sales:150, uniqueBuyers:120, uniqueSellers:80 }).buyerSellerRatio > 1);
assert.equal(outcomeFromMint({mintPriceEth:0.03, snapshot:{floorEth:0.06}}).returnPct, 100);

let state = { research: createResearchState() };
const alert = recordAlert(state, base, good, now, { research:{maxAlerts:100} });
assert(alert.id);
addOutcome(state, alert.id, 360, { returnPct: 25, drawdownPct: -10, floorEth: 0.0375 });
addOutcome(state, alert.id, 60, { returnPct: 10, drawdownPct: -4, floorEth: 0.033 });
for (let i=0;i<8;i++) { const a=recordAlert(state, {...base,name:`C${i}`}, {...good, score:60+i*5}, now+i*1000, {research:{maxAlerts:100}}); addOutcome(state,a.id,360,{returnPct:i-3,drawdownPct:-8}); }
const report = buildBacktestReport(state,{horizonMinutes:360,minScore:70});
assert(report.samples >= 2);
assert(Array.isArray(report.buckets));
assert(Object.keys(report.featureImportance).length);
assert(calibrateThresholds(state,{horizonMinutes:360}).length);

const legacy = { version:1, alerted:{}, telegramOffset:0, overrides:{}, stats:{}, recent:[] };
const normalized = normalizeState(legacy);
assert(Array.isArray(normalized.research.alerts));
assert(Array.isArray(normalized.research.snapshots));
pruneState(legacy, 30, now);
assert(legacy.research && Array.isArray(legacy.research.alerts));
assert(legacy.research && Array.isArray(legacy.research.snapshots));

console.log('FULL UPGRADE TESTS PASSED');
