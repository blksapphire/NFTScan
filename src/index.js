#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node src/index.js                  poll once (default; what CI runs)
 *   node src/index.js --once --dry-run  full cycle, printed to console, nothing sent
 *   node src/index.js --mode=stream     real-time websocket, needs an always-on host
 *   node src/index.js --test-telegram   send one sample card to check your wiring
 *   node src/index.js --new-key         mint a free OpenSea API key and print it
 */

import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { runPoll } from './poll.js';
import { runStream } from './stream.js';
import { Telegram, formatAlert } from './telegram.js';
import { OpenSeaClient } from './opensea.js';
import { scoreCandidate } from './score.js';
import { ciAnnotate } from './util.js';

/**
 * A realistic-looking candidate, used to check formatting and delivery.
 * Scored by the real screener rather than with hand-written numbers, so the test
 * card cannot drift away from what an actual alert looks like.
 */
function sampleAlert(cfg) {
  const now = Date.now();
  const candidate = {
    kind: 'upcoming',
    alertKind: 'upcoming-180',
    leadBucketMinutes: 180,
    name: 'Example Genesis Pass',
    chain: 'ethereum',
    contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
    slug: 'example-genesis-pass',
    openseaUrl: 'https://opensea.io/collection/example-genesis-pass',
    mintPriceEth: 0.029,
    isNativeCurrency: true,
    maxPerWallet: 2,
    stageLabel: 'public_sale',
    startTimeMs: now + 2.5 * 3600 * 1000,
    createdAtMs: now - 2 * 3600 * 1000,
    totalSupply: 5000,
    safelistStatus: 'approved',
    socials: { twitter: 'example', discord: 'https://discord.gg/example', website: null, telegram: null },
    isNsfw: false,
    isDisabled: false,
    topHolders: [],
    uniqueMinters: null,
    totalMints: null,
    mintsPerMinute: null,
  };

  return { candidate, result: scoreCandidate(candidate, cfg, now) };
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig({ argv });
  const state = loadState(cfg.stateFile);

  if (cfg.newKey) {
    const client = new OpenSeaClient({ debug: true });
    const { key, expiresAt } = await client.fetchFreeKey();
    console.log(`\nOpenSea API key: ${key}`);
    console.log(`Expires: ${expiresAt ?? 'unknown (free keys last about 7 days)'}`);
    console.log('\nStore it as the OPENSEA_API_KEY secret. For a key that does not expire,');
    console.log('use opensea.io -> Settings -> Developer instead.\n');
    return;
  }

  if (cfg.testTelegram) {
    const tg = new Telegram({
      token: cfg.telegramToken,
      chatId: cfg.telegramChatId,
      dryRun: cfg.dryRun,
      debug: cfg.debug,
    });
    const { candidate, result } = sampleAlert(cfg);
    await tg.send(formatAlert(candidate, result));
    console.log(
      cfg.dryRun
        ? 'Dry run: sample card printed above.'
        : 'Sample alert sent. If it did not arrive, message your bot once so it can reply to you.'
    );
    return;
  }

  if (cfg.mode === 'stream') {
    await runStream(cfg, state);
    return; // runStream keeps the process alive until a signal arrives.
  }

  await runPoll(cfg, state);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}\n`);
  if (process.env.DEBUG) console.error(err.stack);

  // A failing step's log is collapsed by default on GitHub, so an error only
  // written to stderr is effectively invisible from the run summary. This puts it
  // on the summary itself. `err.title` is set by ConfigError; anything else is a
  // genuine crash and says so.
  ciAnnotate('error', `Mint sniper: ${err.title || 'crashed'}`, err.message);

  process.exit(1);
});
