/* Self-test for the full NFTScan screener. */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

import { stripComments, loadConfig, ConfigError } from '../src/config.js';
import { scoreCandidate, normalisePercentages } from '../src/score.js';
import { MintTracker, parseTransferEvent } from '../src/mints.js';
import { dueLeadBucket } from '../src/sources.js';
import { formatAlert } from '../src/telegram.js';
import { wasAlerted, markAlerted, pruneState, recordRecent, alertKey, loadState, saveState } from '../src/state.js';
import { weiToEth, isMintTransfer, ramp, ZERO_ADDRESS, ciAnnotate } from '../src/util.js';
import { OpenSeaClient, OpenSeaError } from '../src/opensea.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = stripComments(JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')));
let passed = 0;
const failures = [];
function check(name, condition, detail = '') { if (condition) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
function eq(name, actual, expected) { check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function near(name, actual, expected, tolerance = 0.001) { check(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`); }
const NOW = Date.parse('2026-08-22T12:00:00Z');
const HOUR = 3600 * 1000;
function goodCandidate(overrides = {}) {
  return {
    kind: 'live', alertKind: 'live', name: 'Healthy Collection', slug: 'healthy', chain: 'ethereum',
    contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', openseaUrl: 'https://opensea.io/collection/healthy',
    mintPriceEth: 0.03, isNativeCurrency: true, maxPerWallet: 2, totalSupply: 5000, createdAtMs: NOW - 2 * HOUR,
    safelistStatus: 'approved', socials: { twitter: 'healthy', discord: 'https://discord.gg/x', website: 'https://x.com', telegram: null },
    isNsfw: false, isDisabled: false, totalMints: 400, uniqueMinters: 350, mintsPerMinute: 40, previousMintsPerMinute: 25,
    topHolders: [{ address: '0x1', quantity: 5, percentage: 1.2 }, { address: '0x2', quantity: 4, percentage: 1.0 }, { address: '0x3', quantity: 3, percentage: 0.8 }],
    // A well-observed fixture: this is deliberately full coverage for all eight
    // configured components. Real upcoming drops may legitimately omit several.
    walletQuality: { score: 0.9, sharedFundingRatio: 0.05 },
    detectedAtMs: NOW,
    ...overrides,
  };
}

{
  const sum = Object.values(CONFIG.weights).reduce((a, b) => a + Number(b), 0);
  eq('shipped config weights sum to 100', sum, 100);
  check('shipped config has lead times', Array.isArray(CONFIG.leadTimeMinutes) && CONFIG.leadTimeMinutes.length >= 1);
  check('shipped request budget stays below documented minute ceiling at 1 run/minute', CONFIG.budget.maxRequestsPerRun <= 60, `${CONFIG.budget.maxRequestsPerRun}`);
}

{
  near('weiToEth: 1 ETH', weiToEth('1000000000000000000'), 1); near('weiToEth: 0.005 ETH', weiToEth('5000000000000000'), 0.005); near('weiToEth: 0.029 ETH', weiToEth('29000000000000000'), 0.029);
  eq('weiToEth: zero', weiToEth('0'), 0); eq('weiToEth: null', weiToEth(null), null); eq('weiToEth: garbage', weiToEth('not-a-number'), null);
  near('weiToEth: 12345 ETH stays precise', weiToEth('12345000000000000000000'), 12345, 0.01);
  eq('isMintTransfer: zero address', isMintTransfer(ZERO_ADDRESS), true); eq('isMintTransfer: uppercase zero address', isMintTransfer(ZERO_ADDRESS.toUpperCase()), true); eq('isMintTransfer: normal wallet', isMintTransfer('0xabc'), false); eq('isMintTransfer: null', isMintTransfer(null), false);
  eq('ramp below min', ramp(0, 10, 20), 0); eq('ramp above max', ramp(30, 10, 20), 1); near('ramp midpoint', ramp(15, 10, 20), 0.5);
}

{
  const asPercent = normalisePercentages([{ percentage: 40 }, { percentage: 20 }]); eq('percentages already 0-100 are untouched', asPercent.join(','), '40,20');
  const asFraction = normalisePercentages([{ percentage: 0.4 }, { percentage: 0.2 }]); near('fractional percentages are scaled to 0-100', asFraction[0], 40); near('fractional percentages preserve ratio', asFraction[1], 20);
  eq('empty holders', normalisePercentages([]).length, 0); eq('null holders', normalisePercentages(null).length, 0); eq('non-numeric percentages are dropped', normalisePercentages([{ percentage: 'x' }]).length, 0);
}

{
  const disabled = scoreCandidate(goodCandidate({ isDisabled: true }), CONFIG, NOW); check('disabled collection is rejected', disabled.rejected !== null); eq('rejected candidate scores zero', disabled.score, 0);
  const nsfw = scoreCandidate(goodCandidate({ isNsfw: true }), CONFIG, NOW); check('nsfw collection is rejected', nsfw.rejected !== null);
  const noContract = scoreCandidate(goodCandidate({ contractAddress: null }), CONFIG, NOW); check('missing contract address is rejected', noContract.rejected !== null);
  const spamAirdrop = scoreCandidate(goodCandidate({ mintPriceEth: 0, totalSupply: 50000 }), CONFIG, NOW); check('free mint with huge supply is rejected', spamAirdrop.rejected !== null);
  const tooExpensive = scoreCandidate(goodCandidate({ mintPriceEth: 12 }), CONFIG, NOW); check('mint above the price ceiling is rejected', tooExpensive.rejected !== null);
  const freeSmall = scoreCandidate(goodCandidate({ mintPriceEth: 0, totalSupply: 500 }), CONFIG, NOW); eq('free mint on small supply is not rejected', freeSmall.rejected, null);
  const staleCollection = scoreCandidate(goodCandidate({ kind: 'new_collection', createdAtMs: NOW - 200 * HOUR }), CONFIG, NOW); check('collection past freshness window is rejected', staleCollection.rejected !== null);
  const startedAlready = scoreCandidate(goodCandidate({ kind: 'upcoming', startTimeMs: NOW - HOUR }), CONFIG, NOW); check('upcoming mint already began is rejected', startedAlready.rejected !== null);
  const tooFarOut = scoreCandidate(goodCandidate({ kind: 'upcoming', startTimeMs: NOW + 400 * HOUR }), CONFIG, NOW); check('mint further out than lead window is rejected', tooFarOut.rejected !== null);
}

{
  const healthy = scoreCandidate(goodCandidate(), CONFIG, NOW); eq('healthy candidate is not rejected', healthy.rejected, null); check('healthy clears threshold', healthy.score >= CONFIG.minScore, `scored ${healthy.score}`); eq('healthy candidate scores on all eight signals', healthy.available.length, 8);
  const washMinted = scoreCandidate(goodCandidate({ totalMints: 400, uniqueMinters: 3 }), CONFIG, NOW); check('wash-minted scores below healthy', washMinted.score < healthy.score); check('wash-minted falls under threshold', washMinted.score < CONFIG.minScore); check('wash-mint reason is spelled out', washMinted.reasons.some((r) => /self-minting|Concentrated minting/i.test(r)));
  const whaleHeld = scoreCandidate(goodCandidate({ topHolders: [{ address: '0x1', quantity: 900, percentage: 55 }, { address: '0x2', quantity: 200, percentage: 15 }] }), CONFIG, NOW); check('whale-held scores below healthy', whaleHeld.score < healthy.score); check('whale-held is filtered out', whaleHeld.score < CONFIG.minScore); check('concentration is called out', whaleHeld.reasons.some((r) => /Concentrated ownership/i.test(r)));
  const anonymous = scoreCandidate(goodCandidate({ safelistStatus: 'not_requested', socials: {}, walletQuality: null }), CONFIG, NOW); eq('anonymous project is scored, not rejected', anonymous.rejected, null); check('anonymous project scores lower', anonymous.score < healthy.score); check('missing socials surfaced', anonymous.reasons.some((r) => /No socials listed/i.test(r)));
}

{
  const full = goodCandidate();
  const pollShaped = goodCandidate({ totalMints: null, uniqueMinters: null, mintsPerMinute: null, previousMintsPerMinute: null });
  const fullResult = scoreCandidate(full, CONFIG, NOW); const pollResult = scoreCandidate(pollShaped, CONFIG, NOW);
  eq('stream-shaped candidate uses eight signals', fullResult.available.length, 8); eq('poll-shaped candidate uses five signals', pollResult.available.length, 5);
  check('strong poll candidate still clears threshold', pollResult.score >= CONFIG.minScore, `poll scored ${pollResult.score}`);
  check('poll and stream scores remain comparable', Math.abs(pollResult.score - fullResult.score) < 30, `poll ${pollResult.score} vs stream ${fullResult.score}`);
  check('missing signals cannot score higher than having them', pollResult.score <= fullResult.score, `poll ${pollResult.score} must not exceed stream ${fullResult.score}`);
  const nothingKnown = scoreCandidate({ kind:'live', contractAddress:'0xbbbb', name:'Unknown', socials:{}, isNsfw:false, isDisabled:false, mintPriceEth:null, totalSupply:null, createdAtMs:null, topHolders:null, totalMints:null, uniqueMinters:null, mintsPerMinute:null, walletQuality:null }, CONFIG, NOW);
  check('almost-no-data does not crash', Number.isFinite(nothingKnown.score)); check('almost-no-data scores poorly', nothingKnown.score < CONFIG.minScore);
}

{
  const healthy = scoreCandidate(goodCandidate(), CONFIG, NOW);
  eq('full coverage takes no confidence discount', healthy.confidence, 1); eq('clean candidate takes no risk penalty', healthy.riskMultiplier, 1);
  const upcoming = scoreCandidate(goodCandidate({ kind:'upcoming', startTimeMs:NOW + 3 * HOUR, topHolders:[], totalMints:null, uniqueMinters:null, mintsPerMinute:null, previousMintsPerMinute:null }), CONFIG, NOW);
  check('sparse candidate is discounted for low coverage', upcoming.confidence < 1 && upcoming.confidence >= 0.75, `confidence ${upcoming.confidence}`); check('strong upcoming clears threshold', upcoming.score >= CONFIG.minScore, `scored ${upcoming.score}`);
  const severeWhale = scoreCandidate(goodCandidate({ topHolders:[{percentage:55},{percentage:2}] }), CONFIG, NOW); check('55% holder applies severe multiplier', severeWhale.riskMultiplier <= 0.5); check('dump risk is stated plainly', severeWhale.reasons.some((r) => /RISK:.*one wallet holds/i.test(r)));
  const moderateWhale = scoreCandidate(goodCandidate({ topHolders:[{percentage:33},{percentage:2}] }), CONFIG, NOW); check('33% holder penalised less than 55%', moderateWhale.riskMultiplier > severeWhale.riskMultiplier && moderateWhale.riskMultiplier < 1); check('33% holder drops below threshold', moderateWhale.score < CONFIG.minScore);
  const botFarm = scoreCandidate(goodCandidate({ mintPriceEth:0, totalSupply:500, mintsPerMinute:40 }), CONFIG, NOW); eq('fast free mint is scored', botFarm.rejected, null); check('fast free mint filtered out', botFarm.score < CONFIG.minScore); check('bot-farming suspicion stated', botFarm.reasons.some((r) => /RISK:.*bot farming/i.test(r)));
  const organicFree = scoreCandidate(goodCandidate({ mintPriceEth:0, totalSupply:500, mintsPerMinute:8 }), CONFIG, NOW); eq('organic free mint takes no bot penalty', organicFree.riskMultiplier, 1); check('organic free mint outscores bot-farmed', organicFree.score > botFarm.score);
  const cashGrab = scoreCandidate(goodCandidate({ mintPriceEth:1.5, safelistStatus:'not_requested', socials:{}, walletQuality:null }), CONFIG, NOW); check('expensive unverified is filtered out', cashGrab.score < CONFIG.minScore); check('unverified-price risk stated', cashGrab.reasons.some((r) => /RISK:.*unverified collection/i.test(r)));
  const pricyButKnown = scoreCandidate(goodCandidate({ mintPriceEth:1.5 }), CONFIG, NOW); eq('approved collection takes no unverified penalty', pricyButKnown.riskMultiplier, 1); check('overpricing costs points', pricyButKnown.score < healthy.score);
  const multiFail = scoreCandidate(goodCandidate({ safelistStatus:'not_requested', socials:{}, mintPriceEth:1.5, topHolders:[{percentage:55},{percentage:3}], walletQuality:null }), CONFIG, NOW); check('risks compound', multiFail.riskMultiplier < severeWhale.riskMultiplier); check('multiple failures score far below threshold', multiFail.score < CONFIG.minScore / 2);
  const relaxed = { ...CONFIG, risk:{ ...CONFIG.risk, severeTopHolderPenalty:1 } }; const unpenalised = scoreCandidate(goodCandidate({ topHolders:[{percentage:55},{percentage:2}] }), relaxed, NOW); check('risk penalties read config', unpenalised.score > severeWhale.score);
}

{
  const tracker = new MintTracker({ windowMinutes:10, minMints:5, minUniqueMinters:3 }); const contract='0xCONTRACT';
  for (let i=0;i<10;i++) tracker.record({ contractAddress:contract, toAddress:`0xminter${i}`, atMs:NOW - i*10000, slug:'tracked' });
  const stats=tracker.stats(contract,NOW); check('tracker counts mints', stats.totalMints===10); check('tracker counts unique minters', stats.uniqueMinters===10); check('tracker exposes velocity', stats.mintsPerMinute>0); check('hot tracker returns active contract', tracker.hot(NOW).length===1); tracker.prune(NOW+11*60000); check('tracker prunes expired window', tracker.stats(contract,NOW+11*60000)===null);
  const event=parseTransferEvent({item:{nft_id:'ethereum/0xabc/1'},from_account:{address:ZERO_ADDRESS},to_account:{address:'0xdef'},event_timestamp:new Date(NOW).toISOString()}); check('transfer parser extracts contract', event?.contractAddress==='0xabc'); check('transfer parser extracts from address', event?.fromAddress===ZERO_ADDRESS); check('transfer parser extracts recipient', event?.toAddress==='0xdef');
}

{
  const leadTimes=[180,25]; const state={alerted:{}}; const contract='0xabc'; const first=dueLeadBucket(NOW+2*HOUR,leadTimes,state,contract,NOW); eq('2h mint fires 180-minute heads-up',first,180); markAlerted(state,contract,`upcoming-${first}`,new Date(NOW)); eq('180-minute does not fire twice',dueLeadBucket(NOW+2*HOUR,leadTimes,state,contract,NOW),null); const second=dueLeadBucket(NOW+10*60000,leadTimes,state,contract,NOW); eq('25-minute get-ready fires',second,25); markAlerted(state,contract,`upcoming-${second}`,new Date(NOW)); eq('both buckets spent means no further alerts',dueLeadBucket(NOW+10*60000,leadTimes,state,contract,NOW),null); eq('already-started mint fires nothing',dueLeadBucket(NOW-HOUR,leadTimes,{alerted:{}},'0xother',NOW),null); eq('late 5-minute discovery still pings',dueLeadBucket(NOW+5*60000,leadTimes,{alerted:{}},'0xlate',NOW),25);
}

{
  const state={alerted:{},recent:[]}; eq('nothing alerted initially',wasAlerted(state,'0xabc','live'),false); markAlerted(state,'0xABC','live',new Date(NOW)); eq('dedupe case-insensitive',wasAlerted(state,'0xabc','live'),true); eq('different alert kind tracked separately',wasAlerted(state,'0xabc','upcoming-25'),false); eq('dedupe keys normalised',alertKey('0xAbC','live'),'0xabc|live'); state.alerted['0xold|live']=new Date(NOW-60*24*HOUR).toISOString(); state.alerted['0xcorrupt|live']='not-a-date'; const removed=pruneState(state,30,NOW); eq('pruning removes two stale entries',removed,2); eq('recent survives pruning',wasAlerted(state,'0xabc','live'),true); for(let i=0;i<40;i++) recordRecent(state,{name:`Collection ${i}`,kind:'live',score:70},new Date(NOW)); eq('recent capped at 25',state.recent.length,25); eq('newest alert first',state.recent[0].name,'Collection 39');
}

{
  const file=join(tmpdir(),`sniper-state-test-${process.pid}.json`); const state=loadState(file); markAlerted(state,'0x1F98431c8aD98523631AE4a59f267346ea31F984','live',new Date(NOW)); recordRecent(state,{name:'Some Drop',kind:'live',score:82},new Date(NOW)); state.telegramOffset=918273645; state.overrides={minScore:80,paused:false}; state.stats={runs:12,alertsSent:3,lastRunAt:'x',lastAlertAt:'y'}; state.apiKeyExpiresAt='2026-08-29T00:00:00Z'; saveState(file,state); const raw=readFileSync(file,'utf8'); const written=JSON.parse(raw);
  const allowed=['alerted','apiKeyExpiresAt','overrides','recent','stats','telegramOffset','version','research']; const unexpected=Object.keys(written).filter((k)=>!allowed.includes(k)); eq('committed state allowlist includes reviewed research field',unexpected.join(','),'');
  const withoutAddresses=raw.replace(/0x[0-9a-fA-F]+/g,'<address>'); check('committed state contains nothing shaped like a bot token',!/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/.test(raw)); check('committed state contains no bare hex secret',!/\b[0-9a-f]{32,}\b/i.test(withoutAddresses));
  for(const word of ['token','apiKey','api_key','secret','password','privateKey']) check(`committed state has no "${word}" field`,!new RegExp(`"${word}"\\s*:`,'i').test(raw));
  try { rmSync(file,{force:true}); } catch {}
}

{
  const candidate=goodCandidate({kind:'upcoming',startTimeMs:NOW+2*HOUR,leadBucketMinutes:180,name:'<script>alert(1)</script> & "Friends"'}); const result=scoreCandidate(candidate,CONFIG,NOW); const text=formatAlert(candidate,result,NOW);
  check('alert includes score',text.includes(`${result.score}/100`)); check('alert includes countdown',/in 2h/.test(text)); check('alert includes mint price',text.includes('0.0300 ETH')); check('alert includes per-wallet cap',text.includes('Max 2 per wallet')); check('alert includes OpenSea link',text.includes('opensea.io/collection/healthy')); check('alert includes Etherscan link',text.includes('etherscan.io/address/')); check('alert includes disclaimer',/Not financial advice/.test(text)); check('alert states eight signals',/Scored on \d\/8 signals/.test(text)); check('raw script tags escaped',!text.includes('<script>')); check('ampersands escaped',text.includes('&amp;')); check('quotes survive as text',text.includes('Friends'));
  const tags=[...text.matchAll(/<\/?([a-zA-Z]+)/g)].map((m)=>m[1].toLowerCase()); const allowed=new Set(['b','i','a','code']); const unexpected=[...new Set(tags)].filter((t)=>!allowed.has(t)); eq('no unexpected HTML tags emitted',unexpected.join(','),'');
  const live=goodCandidate({kind:'live'}); const liveText=formatAlert(live,scoreCandidate(live,CONFIG,NOW),NOW); check('live labeled minting now',liveText.includes('MINTING NOW')); check('live shows mint rate',/40\.0 mints\/min/.test(liveText)); check('live shows wallet count',/350 wallets/.test(liveText));
  const urgent=goodCandidate({kind:'upcoming',startTimeMs:NOW+20*60000,leadBucketMinutes:25}); const urgentText=formatAlert(urgent,scoreCandidate(urgent,CONFIG,NOW),NOW); check('final-window visually distinct',urgentText.includes('GET READY')); check('clean alert has no risk section',!text.includes('Risk flags'));
  const flagged=goodCandidate({topHolders:[{percentage:33},{percentage:2}]}); const flaggedText=formatAlert(flagged,scoreCandidate(flagged,CONFIG,NOW),NOW); check('risk flags get own section',flaggedText.includes('Risk flags')); check('risk flags appear above reasoning',flaggedText.indexOf('Risk flags')<flaggedText.indexOf('Why this scored')); check('RISK prefix stripped',!flaggedText.includes('RISK:')); check('whale warning rendered',/largest wallet holds 33%/.test(flaggedText));
  const thin=goodCandidate({kind:'upcoming',startTimeMs:NOW+3*HOUR,topHolders:[],totalMints:null,uniqueMinters:null,mintsPerMinute:null,previousMintsPerMinute:null,walletQuality:null}); const thinText=formatAlert(thin,scoreCandidate(thin,CONFIG,NOW),NOW); check('thin data warns discounted',/thin data/.test(thinText)); check('messages stay within Telegram limit',text.length<4000,`${text.length} chars`);
}

{
  const warnings=[]; const realWarn=console.warn; console.warn=(...args)=>warnings.push(args.join(' '));
  try { const failing=new OpenSeaClient({}); let attempts=0; failing.fetchFreeKey=async()=>{attempts++;throw new OpenSeaError('simulated key service outage','KEY_FETCH_FAILED');}; let a; try { await failing.ensureApiKey(); } catch (err) { a=err; } check('failed key mint only attempted once',attempts===1); check('failed key mint is memoised',a?.code==='KEY_FETCH_FAILED'); } finally { console.warn=realWarn; }
}

console.log(`\n${passed} checks passed.`); if (failures.length) { console.log(`${failures.length} FAILED:\n`); for(const f of failures) console.log(`  ✗ ${f}`); process.exitCode=1; } else console.log('ALL CHECKS PASSED');
