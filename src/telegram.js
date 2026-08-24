/**
 * Telegram integration, over plain fetch.
 *
 * Two responsibilities:
 *   - sendAlert(): the formatted alert card
 *   - processCommands(): reading YOUR messages in poll mode
 *
 * The second one needs explaining. A bot on GitHub Actions has no long-running
 * process, so there is nothing listening when you type /pause. Instead each run
 * calls getUpdates with a cursor stored in state, handles whatever arrived since
 * last time, and saves the new cursor. Commands therefore work with up to five
 * minutes of latency, no webhook, and no server. That is the trade for $0.
 */

import { escapeHtml, formatEth, formatRelative, shortAddress } from './util.js';

const API = 'https://api.telegram.org';
/** Telegram rejects messages over 4096 characters. */
const MAX_MESSAGE = 4000;

const EXPLORERS = {
  ethereum: 'https://etherscan.io/address/',
  base: 'https://basescan.org/address/',
  polygon: 'https://polygonscan.com/address/',
  arbitrum: 'https://arbiscan.io/address/',
  optimism: 'https://optimistic.etherscan.io/address/',
  zora: 'https://explorer.zora.energy/address/',
  blast: 'https://blastscan.io/address/',
};

export class Telegram {
  constructor({ token, chatId, dryRun = false, debug = false }) {
    this.token = token;
    this.chatId = chatId;
    this.dryRun = dryRun;
    this.debug = debug;
    this.sentCount = 0;
  }

  log(...args) {
    if (this.debug) console.log('[telegram]', ...args);
  }

  async call(method, payload) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const description = body?.description || `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }
    return body.result;
  }

  /**
   * @param {string} text HTML-formatted
   * @param {object} [options]
   * @param {string|number} [options.chatId] Override the default recipient.
   */
  async send(text, { chatId } = {}) {
    const trimmed = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}\n…(truncated)` : text;

    if (this.dryRun) {
      console.log('\n--- DRY RUN, would send to Telegram ---');
      console.log(stripHtml(trimmed));
      console.log('---------------------------------------\n');
      this.sentCount++;
      return null;
    }

    const result = await this.call('sendMessage', {
      chat_id: chatId ?? this.chatId,
      text: trimmed,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    this.sentCount++;
    return result;
  }

  async sendAlert(candidate, scored, nowMs = Date.now()) {
    return this.send(formatAlert(candidate, scored, nowMs));
  }

  async getUpdates(offset) {
    if (this.dryRun) return [];
    try {
      return (
        (await this.call('getUpdates', {
          offset: offset || 0,
          timeout: 0,
          limit: 20,
          allowed_updates: ['message'],
        })) || []
      );
    } catch (err) {
      console.warn(`[telegram] getUpdates failed: ${err.message}`);
      return [];
    }
  }
}

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, '');
}

function scoreBar(score) {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function headerFor(candidate, nowMs) {
  switch (candidate.kind) {
    case 'upcoming': {
      const when = formatRelative(candidate.startTimeMs, nowMs);
      const urgent = candidate.leadBucketMinutes && candidate.leadBucketMinutes <= 30;
      return `${urgent ? '🔔 GET READY' : '⏳ UPCOMING MINT'} — starts ${when}`;
    }
    case 'live': return '🔴 MINTING NOW';
    case 'new_collection': return '🆕 NEW COLLECTION';
    default: return '📣 SIGNAL';
  }
}

export function formatAlert(candidate, scored, nowMs = Date.now()) {
  const lines = [];
  lines.push(`<b>${escapeHtml(headerFor(candidate, nowMs))}</b>`, '', `<b>${escapeHtml(candidate.name)}</b>`);

  const facts = [];
  if (candidate.chain) facts.push(escapeHtml(candidate.chain));
  if (Number.isFinite(candidate.totalSupply)) facts.push(`${candidate.totalSupply} supply`);
  if (candidate.stageLabel) facts.push(escapeHtml(candidate.stageLabel));
  if (facts.length) lines.push(`<i>${facts.join(' · ')}</i>`);

  lines.push('', `Score <b>${scored.score}/100</b>  ${scoreBar(scored.score)}`, '');

  const details = [];
  if (candidate.mintPriceEth !== null && candidate.mintPriceEth !== undefined) {
    details.push(`💰 Mint: <b>${escapeHtml(formatEth(candidate.mintPriceEth))}</b>${candidate.isNativeCurrency === false ? ' (paid in a token, not ETH)' : ''}`);
  }
  if (Number.isFinite(candidate.maxPerWallet) && candidate.maxPerWallet > 0) details.push(`🎫 Max ${candidate.maxPerWallet} per wallet`);
  if (Number.isFinite(candidate.startTimeMs) && candidate.kind === 'upcoming') details.push(`🕐 Opens ${escapeHtml(new Date(candidate.startTimeMs).toUTCString())}`);
  if (Number.isFinite(candidate.mintsPerMinute)) details.push(`📈 ${candidate.mintsPerMinute.toFixed(1)} mints/min · ${candidate.uniqueMinters} wallets`);
  if (details.length) lines.push(details.join('\n'), '');

  const allReasons = scored.reasons || [];
  const risks = allReasons.filter((r) => /^RISK:/i.test(r));
  const positives = allReasons.filter((r) => !/^RISK:/i.test(r));

  if (risks.length) {
    lines.push('<b>⚠️ Risk flags</b>');
    for (const risk of risks) lines.push(`• <b>${escapeHtml(risk.replace(/^RISK:\s*/i, ''))}</b>`);
    lines.push('');
  }
  if (positives.length) {
    lines.push('<b>Why this scored what it did</b>');
    for (const reason of positives) lines.push(`• ${escapeHtml(reason)}`);
    lines.push('');
  }

  if (scored.available?.length) {
    const coverage = `Scored on ${scored.available.length}/8 signals`;
    const thin = scored.available.length <= 5;
    lines.push(`<i>${coverage}${thin ? ' — thin data, score discounted accordingly' : ''}</i>`, '');
  }

  const links = [];
  if (candidate.openseaUrl) links.push(`<a href="${encodeURI(candidate.openseaUrl)}">OpenSea</a>`);
  if (candidate.contractAddress) {
    const explorer = EXPLORERS[candidate.chain] || EXPLORERS.ethereum;
    links.push(`<a href="${explorer}${encodeURIComponent(candidate.contractAddress)}">Contract</a>`);
  }
  if (candidate.socials?.twitter) links.push(`<a href="https://x.com/${encodeURIComponent(candidate.socials.twitter)}">X</a>`);
  if (candidate.socials?.discord) links.push(`<a href="${encodeURI(candidate.socials.discord)}">Discord</a>`);
  if (candidate.socials?.website) links.push(`<a href="${encodeURI(candidate.socials.website)}">Website</a>`);
  if (links.length) lines.push(links.join(' · '));
  if (candidate.contractAddress) lines.push(`<code>${escapeHtml(candidate.contractAddress)}</code>`);

  lines.push('', '<i>Not financial advice. Verify the contract yourself before spending — this bot checks metrics, not honesty.</i>');
  return lines.join('\n');
}

const HELP = [
  '<b>OpenSea Mint Sniper</b>', '',
  'Commands take effect on the next run, so allow up to 5 minutes.', '',
  '/status — current settings and counters',
  '/threshold 75 — only alert at or above this score (0-100)',
  '/pause — stop alerts, keep watching', '/resume — start alerting again',
  '/recent — the last few alerts', '/help — this message',
].join('\n');

export async function processCommands(tg, state, cfg) {
  const updates = await tg.getUpdates(state.telegramOffset);
  const applied = [];
  for (const update of updates) {
    state.telegramOffset = Math.max(state.telegramOffset || 0, (update.update_id || 0) + 1);
    const message = update.message;
    const text = String(message?.text || '').trim();
    if (!text.startsWith('/')) continue;
    const fromId = String(message?.from?.id ?? '');
    if (cfg.telegramChatId && fromId && fromId !== String(cfg.telegramChatId)) {
      applied.push(`ignored command from unauthorised user ${fromId}`);
      continue;
    }
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    const replyTo = message?.chat?.id;
    switch (command) {
      case '/start': case '/help':
        await tg.send(HELP, { chatId: replyTo }); break;
      case '/status': {
        const s = state.stats || {};
        await tg.send(['<b>Status</b>', '', `Alerting: <b>${state.overrides?.paused ? 'PAUSED' : 'active'}</b>`, `Score threshold: <b>${state.overrides?.minScore ?? cfg.minScore}</b>`, `Chain: ${escapeHtml(cfg.chain || 'ethereum')}`, `Mode: ${escapeHtml(cfg.mode)}`, '', `Runs: ${s.runs ?? 0}`, `Alerts sent: ${s.alertsSent ?? 0}`, `Last run: ${s.lastRunAt ? escapeHtml(s.lastRunAt) : 'never'}`, `Last alert: ${s.lastAlertAt ? escapeHtml(s.lastAlertAt) : 'never'}`, `Contracts remembered: ${Object.keys(state.alerted || {}).length}`].join('\n'), { chatId: replyTo });
        break;
      }
      case '/threshold': {
        const value = Number(args[0]);
        if (!Number.isFinite(value) || value < 0 || value > 100) { await tg.send('Usage: /threshold 75  (a number from 0 to 100)', { chatId: replyTo }); break; }
        state.overrides = { ...state.overrides, minScore: value };
        applied.push(`minScore -> ${value}`);
        await tg.send(`Score threshold set to <b>${value}</b>.`, { chatId: replyTo });
        break;
      }
      case '/pause': state.overrides = { ...state.overrides, paused: true }; applied.push('paused'); await tg.send('Paused. Still watching, not alerting. /resume to turn back on.', { chatId: replyTo }); break;
      case '/resume': state.overrides = { ...state.overrides, paused: false }; applied.push('resumed'); await tg.send('Alerting again.', { chatId: replyTo }); break;
      case '/recent': {
        const recent = Array.isArray(state.recent) ? state.recent.slice(0, 10) : [];
        await tg.send(recent.length ? ['<b>Recent alerts</b>', '', ...recent.map((r) => `${r.score}/100 — ${escapeHtml(r.name)} <i>(${escapeHtml(r.kind)})</i>${r.contractAddress ? `\n<code>${escapeHtml(shortAddress(r.contractAddress))}</code>` : ''}`)].join('\n') : 'No alerts yet.', { chatId: replyTo });
        break;
      }
      default: await tg.send(`Unknown command ${escapeHtml(command)}. Try /help`, { chatId: replyTo });
    }
  }
  return applied;
}
