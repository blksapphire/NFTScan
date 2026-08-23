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
import { describeFetchError } from '../src/util.js';

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
 * @returns {Promise<{ok: boolean, status?: number, code?: string, detail?: string, hint?: string, body?: string}>}
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
    return { ok: true, status: res.status, body: body.slice(0, 300) };
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

console.log('\n=== Verdict ===');
const openseaUp = root.ok || collections.ok || authKeys.ok;

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
