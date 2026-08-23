#!/usr/bin/env node
/**
 * Network diagnostic: `npm run diagnose`
 *
 * Exists because "fetch failed" is the single least useful error in Node, and
 * the bot going quiet is indistinguishable from the bot being broken. This
 * separates the possible causes — DNS, TLS, a proxy, IPv6, a blocked host, a
 * dead endpoint — and names the one that actually applies.
 *
 * Sends nothing to Telegram. Reads only.
 */

import { lookup } from 'node:dns/promises';
import { resolve } from 'node:path';

import { describeFetchError } from '../src/util.js';
import { loadDotEnv, ROOT } from '../src/config.js';

// Read .env, so a key you just pasted in there is the key this checks. Uses the
// loader rather than loadConfig() because loadConfig validates Telegram
// credentials, and a network diagnostic must still run when those are missing.
loadDotEnv(resolve(ROOT, '.env'));

const TIMEOUT_MS = 12000;

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/** Resolve a host both ways, so a broken-IPv6 setup is visible. */
async function checkDns(host) {
  console.log(`\nDNS: ${host}`);
  const out = {};
  for (const family of [4, 6]) {
    try {
      const records = await lookup(host, { family, all: true });
      out[family] = records.map((r) => r.address);
      line(`IPv${family}`, records.map((r) => r.address).join(', ') || '(none)');
    } catch (err) {
      out[family] = null;
      line(`IPv${family}`, `not resolved (${err.code || err.message})`);
    }
  }
  return out;
}

/**
 * One HTTP attempt, reporting the true cause on failure.
 * @returns {Promise<{ok: boolean, status?: number, headers?: Headers, code?: string, detail?: string, hint?: string, body?: string}>}
 */
async function attempt(url, { method = 'GET', headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      signal: ac.signal,
    });
    const body = await res.text().catch(() => '');
    // Response headers are returned so the caller can read the rate-limit ledger,
    // which is the only trustworthy way to see which tier a key is actually on.
    return { ok: true, status: res.status, headers: res.headers, body: body.slice(0, 300) };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', detail: `no response in ${TIMEOUT_MS / 1000}s`, hint: 'A proxy or firewall may be dropping the connection silently.' };
    }
    return { ok: false, ...describeFetchError(err) };
  }
}

function report(label, result) {
  if (result.ok) {
    const verdict = result.status < 400 ? 'reachable' : `reachable, HTTP ${result.status}`;
    line(label, `✅ ${verdict}`);
    if (result.status >= 400 && result.body) line('', `response: ${result.body.replace(/\s+/g, ' ').slice(0, 160)}`);
  } else {
    line(label, `❌ ${result.code}: ${result.detail}`);
    if (result.hint) line('', result.hint);
  }
  return result;
}

/**
 * Proxy URLs routinely embed `user:password@`. This output is meant to be pasted
 * into a chat or an issue, so strip the credentials before printing.
 */
function maskProxy(value) {
  try {
    const u = new URL(value);
    const auth = u.username || u.password ? '<credentials hidden>@' : '';
    return `${u.protocol}//${auth}${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    // Not a parseable URL, so redact anything that looks like embedded credentials.
    return String(value).replace(/\/\/[^/@\s]+@/, '//<credentials hidden>@');
  }
}

console.log('\n=== Mint sniper network diagnostic ===');
line('node', process.version);
line('platform', `${process.platform} ${process.arch}`);
for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY']) {
  if (process.env[v]) line(v, maskProxy(process.env[v]));
}

const openseaDns = await checkDns('api.opensea.io');

console.log('\nOpenSea');
// Widening from the bare host to the specific endpoint isolates *where* it breaks.
const root = report('https://api.opensea.io', await attempt('https://api.opensea.io/'));
const collections = report('GET /api/v2/collections', await attempt('https://api.opensea.io/api/v2/collections?limit=1'));
const authKeys = report('POST /api/v2/auth/keys', await attempt('https://api.opensea.io/api/v2/auth/keys', { method: 'POST' }));

console.log('\nTelegram (control: proves the network itself works)');
const tg = report('https://api.telegram.org', await attempt('https://api.telegram.org/'));

// A second host on the same CDN separates "OpenSea blocks me" from "Cloudflare blocks me".
console.log('\nControl: another Cloudflare-fronted host');
const cf = report('https://cloudflare.com', await attempt('https://cloudflare.com/cdn-cgi/trace'));

/**
 * Validate a configured key against a real authenticated endpoint.
 *
 * Worth its own section because "is this key any good?" is the question you have
 * the moment you paste one in, and every other way of answering it is indirect:
 * a full `npm run dry` mixes key problems together with scoring and Telegram, and
 * the GitHub run tells you only after a five-minute wait. A rejected key here is
 * also the exact failure a free "instant" key produces a week later, so the
 * wording matches what the poller will say.
 */
let keyCheck = null;
if (process.env.OPENSEA_API_KEY) {
  const key = process.env.OPENSEA_API_KEY.trim();
  console.log('\nOPENSEA_API_KEY (from your environment or .env)');
  line('length', `${key.length} characters`);
  if (key !== process.env.OPENSEA_API_KEY) {
    line('whitespace', 'trimmed — the raw value had leading/trailing whitespace');
  }

  const res = await attempt('https://api.opensea.io/api/v2/collections?limit=1', {
    headers: { accept: 'application/json', 'x-api-key': key },
  });
  keyCheck = report('GET /api/v2/collections (authenticated)', res);

  // These are the only reliable way to know your actual tier; the documented
  // numbers are described by OpenSea as examples, not a spec.
  for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const v = res.headers?.get?.(h);
    if (v !== null && v !== undefined) line(h, v);
  }
} else {
  console.log('\nOPENSEA_API_KEY: not set — skipping the authenticated check.');
  console.log('  Set it in .env to verify a key before you paste it into GitHub Secrets.');
}

console.log('\n=== Verdict ===');
const openseaUp = root.ok || collections.ok || authKeys.ok;

// Answer the key question first when there is one, because it is the one that
// decides whether the bot can work at all.
if (keyCheck) {
  if (keyCheck.ok && keyCheck.status < 400) {
    console.log('  Your OPENSEA_API_KEY works. Put this same value in GitHub Secrets as');
    console.log('  OPENSEA_API_KEY and the next scheduled run will use it.');
    console.log('  If it came from the instant/free tier it expires in about 7 days —');
    console.log('  `npm run newkey` mints a replacement.');
  } else if (keyCheck.status === 401 || keyCheck.status === 403) {
    console.log(`  Your OPENSEA_API_KEY was REJECTED (HTTP ${keyCheck.status}).`);
    console.log('  Most likely it has expired (instant keys last 7 days), or it was');
    console.log('  copied incompletely. Run `npm run newkey` for a fresh one.');
  } else if (keyCheck.status === 429) {
    console.log('  Your key is valid but currently rate limited (HTTP 429). Wait for the');
    console.log('  window in x-ratelimit-reset above, then re-run.');
  } else if (!keyCheck.ok) {
    console.log('  Could not test the key because OpenSea was unreachable — see below.');
  } else {
    console.log(`  Unexpected HTTP ${keyCheck.status} for the authenticated call.`);
  }
  console.log();
}

if (openseaUp && authKeys.ok && authKeys.status < 400) {
  console.log('  OpenSea is reachable and the free-key endpoint works. Re-run `npm run dry`.');
} else if (openseaUp && !authKeys.ok) {
  console.log('  OpenSea is reachable but POST /api/v2/auth/keys is not.');
  console.log('  -> Get a key manually: opensea.io -> Settings -> Developer, then put it');
  console.log('     in .env as OPENSEA_API_KEY. That skips this endpoint entirely.');
} else if (openseaUp && authKeys.ok && authKeys.status >= 400) {
  console.log(`  The free-key endpoint answered HTTP ${authKeys.status} — it likely no longer`);
  console.log('  issues anonymous keys. Get one from opensea.io -> Settings -> Developer');
  console.log('  and set OPENSEA_API_KEY in .env.');
} else if (!openseaUp && tg.ok) {
  console.log('  Your network works (Telegram responded) but api.opensea.io does not.');
  if (openseaDns[4] === null && openseaDns[6] === null) {
    console.log('  -> DNS cannot resolve it at all. Try a different resolver (1.1.1.1) or disable a VPN.');
  } else if (!cf.ok) {
    console.log('  -> Another Cloudflare host also failed, so something between you and');
    console.log('     Cloudflare is blocking: ISP, VPN, DNS filter, or corporate proxy.');
  } else {
    console.log('  -> Other Cloudflare hosts work, so this looks specific to OpenSea:');
    console.log('     a regional block or bot filter. A VPN set to the US usually clears it.');
  }
  console.log('  Either way, a manual OPENSEA_API_KEY will NOT help if the host is unreachable.');
} else if (!tg.ok) {
  console.log('  Nothing is reachable — check your internet connection, VPN, or proxy first.');
} else {
  console.log('  Mixed result. Paste this whole output and I can narrow it down.');
}
console.log();
