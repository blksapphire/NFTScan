/** Real-time mode with acceleration scoring and reconnect gap telemetry. */

import { OpenSeaClient } from './opensea.js';
import { Telegram, processCommands } from './telegram.js';
import { MintTracker, parseTransferEvent } from './mints.js';
import { scoreCandidate } from './score.js';
import { enrich } from './sources.js';
import { isMintTransfer } from './util.js';
import { markAlerted, recordRecent, pruneState, saveState } from './state.js';
import { recordAlert } from './research.js';

const SOCKET_BASE = 'wss://stream-api.opensea.io/socket/websocket';
const HEARTBEAT_MS = 30000;
const EVALUATE_EVERY_MS = 60000;
const MAX_ENRICH_PER_CYCLE = 5;
const MIN_RATE_LIMIT_HEADROOM = 20;

async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try { const mod = await import('ws'); return mod.default ?? mod.WebSocket; }
  catch { throw new Error('Stream mode needs Node 22+ with WebSocket support or the optional ws package. Poll mode works on Node 18.'); }
}

export async function runStream(cfg, state) {
  const WebSocketImpl = await resolveWebSocket();
  const tg = new Telegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId, dryRun: cfg.dryRun, debug: cfg.debug });
  const client = new OpenSeaClient({ apiKey: cfg.openseaApiKey, debug: cfg.debug, maxRequests: Infinity });
  await client.ensureApiKey();
  const tracker = new MintTracker({ windowMinutes: Number(cfg.velocity?.windowMinutes) || 10, minMints: Number(cfg.velocity?.minMintsToConsider) || 12, minUniqueMinters: Number(cfg.velocity?.minUniqueMinters) || 8 });
  let socket = null, heartbeat = null, evaluator = null, commandPoller = null;
  let ref = 2, reconnectAttempt = 0, stopping = false, mintsSeen = 0, connectedAt = null, lastDisconnectAt = null;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat); clearInterval(evaluator); clearInterval(commandPoller);
    try { socket?.close(); } catch { /* noop */ }
    pruneState(state, Number(cfg.retention?.dedupeDays) || 30, Date.now(), Number(cfg.research?.retentionDays) || 90);
    saveState(cfg.stateFile, state);
    console.log(`[stream] ${signal}; state saved.`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));

  const connect = () => {
    if (stopping) return;
    const url = `${SOCKET_BASE}?token=${encodeURIComponent(client.apiKey)}&vsn=2.0.0`;
    socket = new WebSocketImpl(url);
    socket.onopen = () => {
      connectedAt = Date.now();
      if (lastDisconnectAt) {
        const gapMs = connectedAt - lastDisconnectAt;
        state.stats.lastStreamGapMs = gapMs;
        state.stats.streamGaps = (state.stats.streamGaps || 0) + 1;
        if (cfg.debug) console.warn(`[stream] reconnect gap ${Math.round(gapMs / 1000)}s`);
      }
      lastDisconnectAt = null;
      reconnectAttempt = 0;
      socket.send(JSON.stringify(['1', '1', 'collection:*', 'phx_join', { event_types: ['item_transferred'] }]));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => { try { socket.send(JSON.stringify([null, String(ref++), 'phoenix', 'heartbeat', {}])); } catch {} }, HEARTBEAT_MS);
    };
    socket.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (!Array.isArray(frame)) return;
      const [, , topic, eventName, payload] = frame;
      if (eventName === 'phx_reply') {
        const status = payload?.status ?? payload?.response?.status;
        if (status && status !== 'ok') console.warn(`[stream] join rejected for ${topic}: ${JSON.stringify(payload)}`);
        return;
      }
      if (eventName !== 'item_transferred') return;
      const transfer = parseTransferEvent(payload?.payload ?? payload);
      if (!transfer || !isMintTransfer(transfer.fromAddress)) return;
      mintsSeen++;
      tracker.record({ contractAddress: transfer.contractAddress, toAddress: transfer.toAddress, atMs: transfer.atMs, slug: transfer.slug, name: transfer.name });
    };
    socket.onerror = (err) => console.warn(`[stream] socket error: ${err?.message ?? 'unknown'}`);
    socket.onclose = () => {
      clearInterval(heartbeat);
      if (stopping) return;
      lastDisconnectAt = Date.now();
      const delay = Math.min(60000, 1000 * 2 ** reconnectAttempt++);
      setTimeout(connect, delay);
    };
  };

  const evaluate = async () => {
    if (stopping || state.overrides?.paused) return;
    tracker.prune(Date.now());
    if (client.rateLimitRemaining !== null && client.rateLimitRemaining < MIN_RATE_LIMIT_HEADROOM) return;
    const minScore = state.overrides?.minScore ?? cfg.minScore;
    const hot = tracker.hot(Date.now());
    let enriched = 0;
    for (const stats of hot) {
      if (enriched >= MAX_ENRICH_PER_CYCLE) break;
      if (state.alerted[`${stats.contractAddress}|live`]) continue;
      const candidate = {
        kind: 'live', source: 'stream:item_transferred', alertKind: 'live', contractAddress: stats.contractAddress,
        slug: stats.slug, name: stats.name || stats.slug || stats.contractAddress, chain: cfg.chain,
        openseaUrl: stats.slug ? `https://opensea.io/collection/${stats.slug}` : null,
        mintPriceEth: null, isNativeCurrency: true, maxPerWallet: null, stageLabel: null, startTimeMs: null, endTimeMs: null,
        totalSupply: null, createdAtMs: null, safelistStatus: null, socials: {}, isNsfw: false, isDisabled: false, topHolders: null,
        totalMints: stats.totalMints, uniqueMinters: stats.uniqueMinters, mintsPerMinute: stats.mintsPerMinute,
        previousMintsPerMinute: stats.previousMintsPerMinute, acceleration: stats.acceleration, detectedAtMs: Date.now(),
      };
      try { await enrich(client, candidate); enriched++; } catch (err) { if (cfg.debug) console.warn(`[stream] enrichment: ${err.message}`); }
      const result = scoreCandidate(candidate, cfg, Date.now());
      if (result.rejected || result.score < minScore) continue;
      try {
        await tg.sendAlert(candidate, result, Date.now());
        markAlerted(state, candidate.contractAddress, 'live');
        recordRecent(state, { name: candidate.name, kind: candidate.kind, score: result.score, riskScore: result.riskScore, confidence: result.confidence, contractAddress: candidate.contractAddress, openseaUrl: candidate.openseaUrl });
        if (cfg.research?.enabled !== false) recordAlert(state, candidate, result, Date.now(), cfg);
        state.stats.alertsSent = (state.stats.alertsSent || 0) + 1;
        state.stats.lastAlertAt = new Date().toISOString();
        saveState(cfg.stateFile, state);
      } catch (err) { console.warn(`[stream] send failed: ${err.message}`); }
    }
    if (cfg.debug) console.log(`[stream] ${mintsSeen} mints · ${hot.length} hot · ${client.requestsUsed} REST requests · gap=${state.stats.lastStreamGapMs || 0}ms`);
  };

  connect();
  evaluator = setInterval(() => evaluate().catch((err) => console.error(`[stream] evaluate failed: ${err.message}`)), EVALUATE_EVERY_MS);
  commandPoller = setInterval(() => processCommands(tg, state, cfg).then((a) => { if (a.length) saveState(cfg.stateFile, state); }).catch((err) => console.warn(`[stream] commands: ${err.message}`)), 15000);
  console.log('[stream] running. Ctrl-C to stop.');
}
