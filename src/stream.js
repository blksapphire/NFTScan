/**
 * Real-time mode.
 *
 * Implements OpenSea's Stream API socket protocol directly rather than pulling
 * in the SDK, because the wire format is small and fully documented, and this
 * keeps the project at zero dependencies:
 *
 *   endpoint  wss://stream-api.opensea.io/socket/websocket?token=<KEY>&vsn=2.0.0
 *   frame     [join_ref, ref, topic, event, payload]
 *   join      ["1", "1", "collection:*", "phx_join", {"event_types": ["item_transferred"]}]
 *   heartbeat [null, "2", "phoenix", "heartbeat", {}]  every 30s
 *
 * We subscribe to `item_transferred` across all collections and keep the ones
 * out of the zero address, which are by definition mints. Streamed events do not
 * count against the REST rate limit, so detection is free; only enrichment of
 * contracts that cross the activity thresholds costs quota.
 *
 * Needs an always-on machine. On GitHub Actions use poll mode instead.
 */

import { OpenSeaClient } from './opensea.js';
import { Telegram, processCommands } from './telegram.js';
import { MintTracker, parseTransferEvent } from './mints.js';
import { scoreCandidate } from './score.js';
import { enrich } from './sources.js';
import { isMintTransfer } from './util.js';
import { markAlerted, recordRecent, wasAlerted, pruneState, saveState } from './state.js';

const SOCKET_BASE = 'wss://stream-api.opensea.io/socket/websocket';
const HEARTBEAT_MS = 30000;
const EVALUATE_EVERY_MS = 60000;
const MAX_ENRICH_PER_CYCLE = 5;
/** Leave headroom in the token bucket so enrichment never starves the API. */
const MIN_RATE_LIMIT_HEADROOM = 20;

/**
 * Node 22+ has a global WebSocket. Node 18 does not, so fall back to the `ws`
 * package if it happens to be installed and explain the fix if it is not.
 */
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.default ?? mod.WebSocket;
  } catch {
    throw new Error(
      'Stream mode needs a WebSocket. Either run Node 22 or newer (which has one built in), ' +
        'or install the optional dependency with:  npm install ws\n' +
        'Poll mode has no such requirement and works on Node 18.'
    );
  }
}

export async function runStream(cfg, state) {
  const WebSocketImpl = await resolveWebSocket();

  const tg = new Telegram({
    token: cfg.telegramToken,
    chatId: cfg.telegramChatId,
    dryRun: cfg.dryRun,
    debug: cfg.debug,
  });

  const client = new OpenSeaClient({
    apiKey: cfg.openseaApiKey,
    debug: cfg.debug,
    // A long-lived process cannot use a per-run budget; header-based limiting
    // and the headroom check below do the pacing instead.
    maxRequests: Infinity,
  });
  await client.ensureApiKey();

  const tracker = new MintTracker({
    windowMinutes: Number(cfg.velocity?.windowMinutes) || 10,
    minMints: Number(cfg.velocity?.minMintsToConsider) || 12,
    minUniqueMinters: Number(cfg.velocity?.minUniqueMinters) || 8,
  });

  let socket = null;
  let heartbeat = null;
  let evaluator = null;
  let commandPoller = null;
  let ref = 2;
  let reconnectAttempt = 0;
  let stopping = false;
  let mintsSeen = 0;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[stream] ${signal} received; saving state and closing.`);
    clearInterval(heartbeat);
    clearInterval(evaluator);
    clearInterval(commandPoller);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    pruneState(state, Number(cfg.retention?.dedupeDays) || 30);
    saveState(cfg.stateFile, state);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const connect = () => {
    if (stopping) return;

    const url = `${SOCKET_BASE}?token=${encodeURIComponent(client.apiKey)}&vsn=2.0.0`;
    console.log('[stream] connecting to OpenSea Stream API…');
    socket = new WebSocketImpl(url);

    socket.onopen = () => {
      reconnectAttempt = 0;
      console.log('[stream] connected; subscribing to item_transferred across all collections.');

      // Server-side filtering: ask only for transfers, not every marketplace event.
      socket.send(
        JSON.stringify(['1', '1', 'collection:*', 'phx_join', { event_types: ['item_transferred'] }])
      );

      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify([null, String(ref++), 'phoenix', 'heartbeat', {}]));
        } catch {
          /* the close handler will reconnect */
        }
      }, HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      let frame;
      try {
        // Frames are always arrays, with or without vsn=2.0.0.
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;

      const [, , topic, eventName, payload] = frame;

      if (eventName === 'phx_reply') {
        const status = payload?.status ?? payload?.response?.status;
        if (status && status !== 'ok') {
          console.warn(`[stream] join rejected for ${topic}: ${JSON.stringify(payload)}`);
        }
        return;
      }

      if (eventName !== 'item_transferred') return;

      // OpenSea wraps the useful part one level down.
      const body = payload?.payload ?? payload;
      const transfer = parseTransferEvent(body);
      if (!transfer) return;
      if (!isMintTransfer(transfer.fromAddress)) return;

      mintsSeen++;
      tracker.record({
        contractAddress: transfer.contractAddress,
        toAddress: transfer.toAddress,
        atMs: transfer.atMs,
        slug: transfer.slug,
        name: transfer.name,
      });
    };

    socket.onerror = (err) => {
      console.warn(`[stream] socket error: ${err?.message ?? 'unknown'}`);
    };

    socket.onclose = () => {
      clearInterval(heartbeat);
      if (stopping) return;
      // Exponential backoff, capped at 60s.
      const delay = Math.min(60000, 1000 * 2 ** reconnectAttempt);
      reconnectAttempt++;
      console.warn(`[stream] disconnected; reconnecting in ${Math.round(delay / 1000)}s.`);
      setTimeout(connect, delay);
    };
  };

  /** Score whatever has gone hot since the last cycle, and alert on winners. */
  const evaluate = async () => {
    if (stopping) return;
    const nowMs = Date.now();
    tracker.prune(nowMs);

    if (state.overrides?.paused) return;

    if (
      client.rateLimitRemaining !== null &&
      client.rateLimitRemaining < MIN_RATE_LIMIT_HEADROOM
    ) {
      console.log(
        `[stream] holding off on enrichment; only ${client.rateLimitRemaining} requests left in the bucket.`
      );
      return;
    }

    const minScore = state.overrides?.minScore ?? cfg.minScore;
    const hot = tracker.hot(nowMs);
    let enriched = 0;

    for (const stats of hot) {
      if (enriched >= MAX_ENRICH_PER_CYCLE) break;
      if (wasAlerted(state, stats.contractAddress, 'live')) continue;

      const candidate = {
        kind: 'live',
        source: 'stream:item_transferred',
        alertKind: 'live',
        contractAddress: stats.contractAddress,
        slug: stats.slug,
        name: stats.name || stats.slug || stats.contractAddress,
        chain: cfg.chain,
        openseaUrl: stats.slug ? `https://opensea.io/collection/${stats.slug}` : null,

        mintPriceEth: null,
        isNativeCurrency: true,
        maxPerWallet: null,
        stageLabel: null,
        startTimeMs: null,
        endTimeMs: null,

        totalSupply: null,
        createdAtMs: null,
        safelistStatus: null,
        socials: {},
        isNsfw: false,
        isDisabled: false,
        topHolders: null,

        // The signals only real-time observation can provide.
        totalMints: stats.totalMints,
        uniqueMinters: stats.uniqueMinters,
        mintsPerMinute: stats.mintsPerMinute,

        detectedAtMs: nowMs,
      };

      try {
        await enrich(client, candidate);
        enriched++;
      } catch (err) {
        console.warn(`[stream] enrichment failed for ${candidate.name}: ${err.message}`);
      }

      const result = scoreCandidate(candidate, cfg, nowMs);
      if (result.rejected) {
        if (cfg.debug) console.log(`[stream] reject ${candidate.name}: ${result.rejected}`);
        continue;
      }
      if (result.score < minScore) {
        if (cfg.debug) console.log(`[stream] ${candidate.name} scored ${result.score} < ${minScore}`);
        continue;
      }

      try {
        await tg.sendAlert(candidate, result, nowMs);
        markAlerted(state, candidate.contractAddress, 'live');
        recordRecent(state, {
          name: candidate.name,
          kind: candidate.kind,
          score: result.score,
          contractAddress: candidate.contractAddress,
          openseaUrl: candidate.openseaUrl,
        });
        state.stats.alertsSent = (state.stats.alertsSent || 0) + 1;
        state.stats.lastAlertAt = new Date().toISOString();
        saveState(cfg.stateFile, state);
        console.log(`[stream] alerted: ${candidate.name} (${result.score}/100)`);
      } catch (err) {
        console.error(`[stream] send failed for ${candidate.name}: ${err.message}`);
      }
    }

    console.log(
      `[stream] ${mintsSeen} mints seen · ${tracker.contracts.size} contracts in window · ` +
        `${hot.length} above thresholds · ${client.requestsUsed} API requests used`
    );
  };

  connect();
  evaluator = setInterval(() => {
    evaluate().catch((err) => console.error(`[stream] evaluate failed: ${err.message}`));
  }, EVALUATE_EVERY_MS);

  // Commands still work here; a long-lived process could use long-polling, but
  // reusing the same path as poll mode keeps one implementation of the logic.
  commandPoller = setInterval(() => {
    processCommands(tg, state, cfg)
      .then((applied) => {
        if (applied.length) {
          console.log(`[stream] applied commands: ${applied.join(', ')}`);
          saveState(cfg.stateFile, state);
        }
      })
      .catch((err) => console.warn(`[stream] command poll failed: ${err.message}`));
  }, 15000);

  console.log('[stream] running. Ctrl-C to stop.');
}
