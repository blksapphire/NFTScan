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

function scanRow(candidate, result) {
  return {
    name: candidate.name || 'Unnamed collection',
    kind: candidate.kind || 'unknown',
    source: candidate.source || 'unknown',
    score: result.score,
    coverage: result.available?.length || 0,
    riskScore: result.riskScore ?? 0,
    confidence: result.confidence ?? 0,
    rejected: result.rejected || null,
    contractAddress: candidate.contractAddress || null,
    slug: candidate.slug || null,
    chain: candidate.chain || null,
  };
}

function discoveredRow(candidate) {
  return {
    name: candidate.name || 'Unnamed collection',
    kind: candidate.kind || 'unknown',
    source: candidate.source || 'unknown',
    contractAddress: candidate.contractAddress || null,
    slug: candidate.slug || null,
    chain: candidate.chain || null,
  };
}

export async function runPoll(cfg, state) {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const tg = new Telegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId, dryRun: cfg.dryRun, debug: cfg.debug });
  const applied = await processCommands(tg, state, cfg);
  if (applied.length) console.log(`[poll] applied commands: ${applied.join(', ')}`);
  const minScore = state.overrides?.minScore ?? cfg.minScore;
  const minSignalCoverage = Math.max(1, Number(cfg.alerts?.minSignalCoverage) || 5);
  const paused = Boolean(state.overrides?.paused);
  state.stats.runs = (state.stats.runs || 0) + 1;
  state.stats.lastRunAt = startedAt;
  if (paused) { console.log('[poll] paused; skipping detection. /resume to re-enable.'); finish(cfg, state); return { alerts: 0, paused: true }; }

  const maxRequests = Number(cfg.budget?.maxRequestsPerRun) || 50;
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
    try {
      const found = await run();
      succeeded++;
      console.log(`[poll] ${label}: ${found.length} candidate(s)`);
      candidates.push(...found);
    } catch (err) {
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
  if (!candidates.length) {
    state.lastScan = { at: startedAt, discovered: [], scored: [], meta: { attempted, succeeded, requests: client.requestsUsed } };
    finish(cfg, state);
    return { alerts: 0, paused: false, sourcesOk: succeeded, sourcesAttempted: attempted };
  }

  candidates.sort((a, b) => {
    const rank = (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9);
    if (rank) return rank;
    return (Number(b.mintPriceEth) || 0) - (Number(a.mintPriceEth) || 0);
  });

  const stageOneLimit = Number(cfg.budget?.stageOneCandidates) || 22;
  const stageOne = [];
  for (const candidate of candidates.slice(0, stageOneLimit)) {
    if (client.requestsUsed + 1 + reserve > client.maxRequests) break;
    try {
      await enrich(client, candidate, { withHolders: false });
      stageOne.push({ candidate, result: scoreCandidate(candidate, cfg, nowMs) });
    } catch (err) {
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) break;
      if (cfg.debug) console.warn(`[poll] stage-1 enrichment warning for ${candidate.name}: ${err.message}`);
    }
  }

  const eventLimit = Number(cfg.budget?.mintEventCandidates) || 16;
  const eventWindowMinutes = Number(cfg.budget?.mintEventWindowMinutes) || Number(cfg.velocity?.windowMinutes) || 10;
  const afterSeconds = Math.floor((nowMs - eventWindowMinutes * 60000) / 1000);
  const liveCandidates = stageOne.filter(({ candidate }) => candidate.kind === 'live' && candidate.slug).sort((a, b) => b.result.score - a.result.score).slice(0, eventLimit);
  let eventEnriched = 0;
  for (const { candidate } of liveCandidates) {
    if (client.requestsUsed + 1 + reserve > client.maxRequests) break;
    try {
      const events = await client.getMintEventsByCollection(candidate.slug, { after: afterSeconds, limit: 200 });
      const stats = buildMintStats(events, nowMs, eventWindowMinutes);
      if (stats.totalMints > 0) {
        candidate.totalMints = stats.totalMints;
        candidate.uniqueMinters = stats.uniqueMinters;
        candidate.mintsPerMinute = stats.mintsPerMinute;
        candidate.previousMintsPerMinute = stats.previousMintsPerMinute;
        candidate.mintAcceleration = stats.acceleration;
        eventEnriched++;
      }
    } catch (err) {
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) break;
      if (cfg.debug) console.warn(`[poll] mint-event enrichment warning for ${candidate.name}: ${err.message}`);
    }
  }

  for (const entry of stageOne) entry.result = scoreCandidate(entry.candidate, cfg, nowMs);
  stageOne.sort((a, b) => b.result.score - a.result.score);

  const holderLimit = Number(cfg.budget?.holderCandidates) || 4;
  const holderCandidates = stageOne.filter(({ candidate }) => candidate.kind !== 'upcoming' && candidate.slug).slice(0, holderLimit);
  let holderEnriched = 0;
  for (const { candidate } of holderCandidates) {
    if (client.requestsUsed + 1 + reserve > client.maxRequests) break;
    try {
      await enrich(client, candidate, { withHolders: true });
      if (candidate.topHolders?.length) holderEnriched++;
    } catch (err) {
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) break;
      if (cfg.debug) console.warn(`[poll] holder enrichment warning for ${candidate.name}: ${err.message}`);
    }
  }

  const scored = [];
  const explainRows = [];
  let scoreQualified = 0;
  let coverageSuppressed = 0;
  let riskFlagged = 0;
  for (const { candidate } of stageOne) {
    const result = scoreCandidate(candidate, cfg, nowMs);
    explainRows.push({ candidate, result });
    if ((result.riskScore || 0) >= 40) riskFlagged++;
    if (result.rejected || result.score < minScore) continue;
    scoreQualified++;
    if ((result.available?.length || 0) < minSignalCoverage) { coverageSuppressed++; continue; }
    scored.push({ candidate, result });
  }

  state.lastScan = {
    at: startedAt,
    discovered: candidates.slice(0, 200).map(discoveredRow),
    scored: explainRows.map(({ candidate, result }) => scanRow(candidate, result)).slice(0, 200),
    meta: {
      attempted, succeeded,
      requests: client.requestsUsed,
      eventEnriched, holderEnriched,
      totalDiscovered: candidates.length,
      totalScored: explainRows.length,
      scoreQualified,
      coverageSuppressed,
      riskFlagged,
    },
  };

  if (cfg.explain) printExplainReport(explainRows, { threshold: minScore, minSignalCoverage, totalCandidates: candidates.length, apiRequests: client.requestsUsed, eventEnriched, holderEnriched, scoreQualified, coverageSuppressed, riskFlagged });

  scored.sort((a, b) => (b.result.score - a.result.score) || ((a.result.riskScore || 0) - (b.result.riskScore || 0)));
  const toSend = scored.slice(0, Number(cfg.maxAlertsPerRun) || 6);
  console.log(`[poll] ${toSend.length} passed the screener and coverage gate; sending ${toSend.length}.`);

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

function buildMintStats(events, nowMs, windowMinutes) {
  const normalized = [];
  for (const event of events || []) {
    const at = Date.parse(event?.event_timestamp ?? event?.timestamp ?? event?.occurred_at ?? '');
    if (!Number.isFinite(at)) continue;
    const to = String(event?.to_address ?? event?.to_account?.address ?? event?.recipient?.address ?? event?.nft?.owner?.address ?? event?.nft?.owner ?? '').toLowerCase();
    if (!to) continue;
    normalized.push({ at, to });
  }
  const cutoff = nowMs - windowMinutes * 60000;
  const live = normalized.filter((e) => e.at >= cutoff && e.at <= nowMs).sort((a, b) => a.at - b.at);
  if (!live.length) return { totalMints: 0, uniqueMinters: 0, mintsPerMinute: 0, previousMintsPerMinute: 0, acceleration: 0 };
  const elapsed = Math.max(0.5, (nowMs - live[0].at) / 60000);
  const current = live.length / elapsed;
  const midpoint = cutoff + windowMinutes * 30000;
  const oldEvents = live.filter((e) => e.at < midpoint);
  const newEvents = live.filter((e) => e.at >= midpoint);
  const oldVelocity = oldEvents.length ? oldEvents.length / Math.max(0.5, (midpoint - oldEvents[0].at) / 60000) : current;
  const newVelocity = newEvents.length ? newEvents.length / Math.max(0.5, (nowMs - newEvents[0].at) / 60000) : current;
  const previous = oldEvents.length ? oldVelocity : newVelocity;
  return {
    totalMints: live.length,
    uniqueMinters: new Set(live.map((e) => e.to)).size,
    mintsPerMinute: current,
    previousMintsPerMinute: previous,
    acceleration: previous > 0 ? (current - previous) / previous : 0,
  };
}

function printExplainReport(rows, { threshold, minSignalCoverage, totalCandidates, apiRequests, eventEnriched, holderEnriched, scoreQualified, coverageSuppressed, riskFlagged }) {
  const hardRejected = rows.filter(({ result }) => result.rejected).length;
  const scoredRows = rows.filter(({ result }) => !result.rejected);
  const belowThreshold = scoredRows.filter(({ result }) => result.score < threshold).length;
  const coverageCounts = {};
  for (const { result } of scoredRows) {
    const n = result.available?.length || 0;
    coverageCounts[n] = (coverageCounts[n] || 0) + 1;
  }
  const top = [...scoredRows].sort((a, b) => b.result.score - a.result.score).slice(0, 10);
  console.log('\n[poll] EXPLAIN REPORT');
  console.log('────────────────────────────────────────');
  console.log(`Candidates discovered: ${totalCandidates}`);
  console.log(`Candidates enriched/scored: ${rows.length}`);
  console.log(`Hard rejected: ${hardRejected}`);
  console.log(`Below threshold (${threshold}): ${belowThreshold}`);
  console.log(`Score-qualified: ${scoreQualified}`);
  console.log(`Coverage-suppressed (<${minSignalCoverage}/8): ${coverageSuppressed}`);
  console.log(`Risk-flagged (risk >= 40): ${riskFlagged}`);
  console.log(`Mint-event enriched: ${eventEnriched}`);
  console.log(`Holder enriched: ${holderEnriched}`);
  console.log(`API requests used: ${apiRequests}`);
  console.log(`Signal coverage: ${Object.entries(coverageCounts).sort(([a],[b]) => Number(a)-Number(b)).map(([n,c]) => `${n}/8=${c}`).join(', ') || 'none'}`);
  console.log('\nTop candidates:');
  if (!top.length) console.log('none');
  for (const { candidate, result } of top) {
    console.log(`• ${candidate.name || '(unnamed)'} — ${result.score}/100 | confidence ${Math.round((result.confidence || 0) * 100)}% | risk ${result.riskScore ?? 0} | coverage ${result.available?.length || 0}/8`);
    for (const reason of (result.reasons || []).slice(0, 6)) console.log(`  - ${reason}`);
  }
  console.log('────────────────────────────────────────\n');
}

function finish(cfg, state) {
  const removed = pruneState(state, Number(cfg.retention?.dedupeDays) || 30, Date.now(), Number(cfg.research?.retentionDays) || 90);
  if (removed && cfg.debug) console.log(`[poll] pruned ${removed} expired dedupe entries`);
  saveState(cfg.stateFile, state);
}
