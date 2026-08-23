/**
 * One poll cycle: the $0 path.
 *
 * Runs to completion and exits, which is what a cron/GitHub Actions runner
 * needs. Everything that must outlive the process is written back to state.
 *
 * Ordering is deliberate. Commands are read first so a /threshold you sent two
 * minutes ago applies to this run rather than the next one. Then detection, then
 * enrichment of survivors only, then scoring, then sending.
 */

import { OpenSeaClient, OpenSeaError } from './opensea.js';
import { Telegram, processCommands } from './telegram.js';
import { scoreCandidate } from './score.js';
import {
  collectUpcoming,
  collectLive,
  collectNewCollections,
  enrich,
} from './sources.js';
import { markAlerted, recordRecent, pruneState, saveState } from './state.js';
import { ciAnnotate } from './util.js';

/** Contract address if we have one, otherwise the slug. Never undefined. */
function dedupeIdFor(candidate) {
  return candidate.contractAddress || candidate.slug || 'unknown';
}

/** Upcoming mints are time-critical, so they get the budget first. */
const KIND_PRIORITY = { upcoming: 0, live: 1, new_collection: 2 };

/**
 * Errors that end the whole run rather than just the current source.
 *
 * Quota exhaustion and "we have no usable API key" are both conditions where
 * trying the next source just reproduces the same failure — so we stop and say
 * it once instead of printing an identical error per collector.
 */
const RUN_ENDING_CODES = [
  'BUDGET',
  'EXHAUSTED',
  'RATE_LIMITED',
  'KEY_FETCH_FAILED',
  'KEY_RATE_LIMITED',
  'KEY_REJECTED',
  'KEY_SHAPE_UNEXPECTED',
];

export async function runPoll(cfg, state) {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs).toISOString();

  const tg = new Telegram({
    token: cfg.telegramToken,
    chatId: cfg.telegramChatId,
    dryRun: cfg.dryRun,
    debug: cfg.debug,
  });

  // 1. Commands you sent since the last run, applied before we screen anything.
  const applied = await processCommands(tg, state, cfg);
  if (applied.length) console.log(`[poll] applied commands: ${applied.join(', ')}`);

  const minScore = state.overrides?.minScore ?? cfg.minScore;
  const paused = Boolean(state.overrides?.paused);

  state.stats.runs = (state.stats.runs || 0) + 1;
  state.stats.lastRunAt = startedAt;

  if (paused) {
    console.log('[poll] paused; skipping detection. /resume to re-enable.');
    finish(cfg, state);
    return { alerts: 0, paused: true };
  }

  const client = new OpenSeaClient({
    apiKey: cfg.openseaApiKey,
    debug: cfg.debug,
    maxRequests: Number(cfg.budget?.maxRequestsPerRun) || 40,
  });

  // 2. Collect. Each source is independent, so one failing must not sink the run.
  const candidates = [];
  const sources = cfg.sources || {};

  // Tracked so a run where nothing worked cannot pass for a run that found nothing.
  let attempted = 0;
  let succeeded = 0;
  /** @type {{label: string, message: string, code?: string}[]} */
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
      console.log(`[poll] ${label}: ${found.length} candidate(s) past the cheap filters`);
      candidates.push(...found);
    } catch (err) {
      failures.push({ label, message: err.message, code: err.code });
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) {
        console.warn(`[poll] ${label}: ${err.message}`);
        break; // Nothing else can succeed this run; work with what we have.
      }
      console.error(`[poll] ${label} failed: ${err.message}`);
    }
  }

  // Every enabled source failed, so this run saw nothing at all — which is very
  // different from "looked, found nothing" and must not read as success.
  if (attempted > 0 && succeeded === 0) {
    const first = failures[0];
    const keyProblem = failures.some((f) => String(f.code || '').startsWith('KEY_'));
    const expired = failures.some((f) => f.code === 'KEY_REJECTED');

    console.error(
      `[poll] NO SOURCE SUCCEEDED — this run screened nothing. ` +
        (RUN_ENDING_CODES.includes(String(first.code))
          ? `Stopped after a fatal error on "${first.label}"; the remaining sources ` +
            `would have hit the same wall.`
          : `${failures.length}/${attempted} source(s) failed.`)
    );

    // The title is what shows on the run summary, so it has to name the actual
    // fault: an expired key and an absent key need different actions.
    let title = 'Mint sniper: OpenSea unreachable';
    if (expired) title = 'Mint sniper: OpenSea API key rejected (probably expired)';
    else if (keyProblem) title = 'Mint sniper: no OpenSea API key';

    ciAnnotate(
      'error',
      title,
      keyProblem
        ? `This run screened nothing because it has no usable OpenSea API key.\n` +
            `${first.message}\n` +
            (expired
              ? `Replace it: run \`npm run newkey\` locally, then update the OPENSEA_API_KEY ` +
                `secret under Settings -> Secrets and variables -> Actions.`
              : `Fix: add a repository secret named OPENSEA_API_KEY (Settings -> Secrets and ` +
                `variables -> Actions) using a key from opensea.io -> Settings -> Developer.`)
        : `This run screened nothing — all ${attempted} source(s) failed.\n${first.message}\n` +
            `If this clears on the next run it was a transient blip and can be ignored.`
    );
  }

  if (candidates.length === 0) {
    console.log(
      succeeded === 0
        ? '[poll] no candidates, because no source could be read. See the error above.'
        : `[poll] ${succeeded}/${attempted} source(s) read fine; nothing new to look at.`
    );
    finish(cfg, state);
    return { alerts: 0, paused: false, sourcesOk: succeeded, sourcesAttempted: attempted };
  }

  // 3. Enrich in priority order, within whatever budget is left. Each candidate
  //    costs one or two requests, so cap conservatively.
  candidates.sort((a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9));

  const remainingRequests = Math.max(0, client.maxRequests - client.requestsUsed);
  const enrichCap = Math.max(0, Math.floor(remainingRequests / 2));
  if (candidates.length > enrichCap) {
    console.log(
      `[poll] ${candidates.length} candidates but budget allows ~${enrichCap}; ` +
        `deferring ${candidates.length - enrichCap} to the next run.`
    );
  }

  const scored = [];
  for (const candidate of candidates.slice(0, enrichCap)) {
    try {
      await enrich(client, candidate);
    } catch (err) {
      if (err instanceof OpenSeaError && RUN_ENDING_CODES.includes(err.code)) {
        console.warn(`[poll] enrichment stopped: ${err.message}`);
        break;
      }
      console.warn(`[poll] could not enrich ${candidate.slug || candidate.contractAddress}: ${err.message}`);
    }

    const result = scoreCandidate(candidate, cfg, nowMs);

    if (result.rejected) {
      if (cfg.debug) console.log(`[poll] reject ${candidate.name}: ${result.rejected}`);
      continue;
    }
    if (result.score < minScore) {
      if (cfg.debug) {
        console.log(`[poll] below threshold ${candidate.name}: ${result.score} < ${minScore}`);
      }
      continue;
    }
    scored.push({ candidate, result });
  }

  // 4. Best first, then cap so a busy hour cannot flood your phone.
  scored.sort((a, b) => b.result.score - a.result.score);
  const toSend = scored.slice(0, Number(cfg.maxAlertsPerRun) || 6);

  console.log(
    `[poll] ${scored.length} passed the screener (threshold ${minScore}); sending ${toSend.length}.`
  );

  let sent = 0;
  for (const { candidate, result } of toSend) {
    try {
      await tg.sendAlert(candidate, result, nowMs);
      markAlerted(state, dedupeIdFor(candidate), candidate.alertKind || candidate.kind);
      recordRecent(state, {
        name: candidate.name,
        kind: candidate.kind,
        score: result.score,
        contractAddress: candidate.contractAddress,
        openseaUrl: candidate.openseaUrl,
      });
      sent++;
      state.stats.lastAlertAt = new Date().toISOString();
    } catch (err) {
      // Do not mark as alerted: an unsent alert should be retried next run.
      console.error(`[poll] failed to send alert for ${candidate.name}: ${err.message}`);
    }
  }

  state.stats.alertsSent = (state.stats.alertsSent || 0) + sent;

  console.log(
    `[poll] done. ${sent} alert(s) sent, ${client.requestsUsed} API request(s) used` +
      (client.rateLimitRemaining !== null ? `, ${client.rateLimitRemaining} left in the bucket` : '')
  );

  finish(cfg, state);
  return { alerts: sent, paused: false };
}

function finish(cfg, state) {
  const removed = pruneState(state, Number(cfg.retention?.dedupeDays) || 30);
  if (removed && cfg.debug) console.log(`[poll] pruned ${removed} expired dedupe entries`);
  saveState(cfg.stateFile, state);
}
