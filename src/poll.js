/** One poll cycle: detect -> enrich -> score -> alert -> record outcome. */

import { OpenSeaClient, OpenSeaError } from './opensea.js';
import { Telegram, processCommands } from './telegram.js';
import { scoreCandidate } from './score.js';
import { collectUpcoming, collectLive, collectNewCollections, enrich } from './sources.js';
import { markAlerted, recordRecent, pruneState, saveState } from './state.js';
import { recordAlert } from './research.js';
import { ciAnnotate } from './util.js';

function dedupeIdFor(candidate) { return candidate.contractAddress || candidate.slug || 'unknown'; }
const KIND_PRIORITY = { upcoming: 0, live: 1, new_collection: 2 };
const RUN_ENDING_CODES = ['BUDGET','EXHAUSTED','RATE_LIMITED','KEY_FETCH_FAILED','KEY_RATE_LIMITED','KEY_REJECTED','KEY_SHAPE_UNEXPECTED'];

export async function runPoll(cfg, state) {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const tg = new Telegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId, dryRun: cfg.dryRun, debug: cfg.debug });
  const applied = await processCommands(tg, state, cfg);
  if (applied.length) console.log(`[poll] applied commands: ${applied.join(', ')}`);
  const minScore = state.overrides?.minScore ?? cfg.minScore;
  const paused = Boolean(state.overrides?.paused);
  state.stats.runs = (state.stats.runs || 0) + 1;
  state.stats.lastRunAt = startedAt;
  if (paused) { console.log('[poll] paused; skipping detection. /resume to re-enable.'); finish(cfg, state); return { alerts: 0, paused: true }; }

  const maxRequests = Number(cfg.budget?.maxRequestsPerRun) || 40;
  const reserve = Math.max(0, Number(cfg.budget?.reserveRequests) || 0);
  const client = new OpenSeaClient({ apiKey: cfg.openseaApiKey, debug: cfg.debug, maxRequests });
  const candidates = [];
  const sources = cfg.sources || {};
  let attempted = 0, succeeded = 0;
  const failures = [];
  const collectors = [
    ['upcoming drops', sources.upcomingDrops, () => collectUpcoming(client, cfg, state, nowMs)],
    ['recently minted', sources.recentlyMinted, () => collectLive(client, cfg, state, nowMs)],
    ['new collections', sources.newCollections, () => collectNewCollections(client, cfg, state, nowMs)],
  ];
  for (const [label, enabled, run] of collectors) {
    if (!enabled) continue;
    attempted++;
    try { const found = await run(); succeeded++; console.log(`[poll] ${label}: ${found.length} candidate(s)`); candidates.push(...found); }
    catch (err) {
      failures.push({ label, message: err.message, code: err.code });
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) break;
      console.error(`[poll] ${label} failed: ${err.message}`);
    }
  }
  if (attempted > 0 && succeeded === 0) {
    const first = failures[0];
    const keyProblem = failures.some((f) => String(f.code || '').startsWith('KEY_'));
    ciAnnotate('error', keyProblem ? 'Mint scanner: no usable OpenSea API key' : 'Mint scanner: OpenSea source failure', first?.message || 'No source succeeded');
  }
  if (!candidates.length) { finish(cfg, state); return { alerts: 0, paused: false, sourcesOk: succeeded, sourcesAttempted: attempted }; }

  candidates.sort((a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9));
  const remainingRequests = Math.max(0, client.maxRequests - client.requestsUsed - reserve);
  // Collection detail + holders is normally 2 requests. Upcoming drops do not
  // need holders, so they get a better effective capacity.
  const scored = [];
  for (const candidate of candidates) {
    const estimatedCost = candidate.kind === 'upcoming' ? 1 : 2;
    if (client.requestsUsed + estimatedCost + reserve > client.maxRequests) break;
    try { await enrich(client, candidate, { withHolders: candidate.kind !== 'upcoming' }); }
    catch (err) {
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) break;
      if (cfg.debug) console.warn(`[poll] enrichment warning for ${candidate.name}: ${err.message}`);
    }
    const result = scoreCandidate(candidate, cfg, nowMs);
    if (result.rejected || result.score < minScore) continue;
    scored.push({ candidate, result });
  }

  scored.sort((a, b) => (b.result.score - a.result.score) || ((a.result.riskScore || 0) - (b.result.riskScore || 0)));
  const toSend = scored.slice(0, Number(cfg.maxAlertsPerRun) || 6);
  console.log(`[poll] ${scored.length} passed the screener; sending ${toSend.length}.`);

  let sent = 0;
  for (const { candidate, result } of toSend) {
    try {
      await tg.sendAlert(candidate, result, nowMs);
      markAlerted(state, dedupeIdFor(candidate), candidate.alertKind || candidate.kind);
      recordRecent(state, { name: candidate.name, kind: candidate.kind, score: result.score, riskScore: result.riskScore, confidence: result.confidence, contractAddress: candidate.contractAddress, openseaUrl: candidate.openseaUrl });
      if (cfg.research?.enabled !== false) recordAlert(state, candidate, result, nowMs, cfg);
      sent++;
      state.stats.lastAlertAt = new Date().toISOString();
    } catch (err) { console.error(`[poll] failed to send alert for ${candidate.name}: ${err.message}`); }
  }
  state.stats.alertsSent = (state.stats.alertsSent || 0) + sent;
  console.log(`[poll] done. ${sent} alert(s) sent, ${client.requestsUsed} API request(s) used${client.rateLimitRemaining !== null ? `, ${client.rateLimitRemaining} left` : ''}`);
  finish(cfg, state);
  return { alerts: sent, paused: false };
}

function finish(cfg, state) {
  const removed = pruneState(state, Number(cfg.retention?.dedupeDays) || 30, Date.now(), Number(cfg.research?.retentionDays) || 90);
  if (removed && cfg.debug) console.log(`[poll] pruned ${removed} expired dedupe entries`);
  saveState(cfg.stateFile, state);
}
