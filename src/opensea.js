/**
 * OpenSea REST client.
 *
 * Current OpenSea instant-key behavior is documented at docs.opensea.io:
 *   - POST /api/v2/auth/keys creates a free-tier key without authentication
 *   - instant keys expire after 30 days
 *   - free tier allows 60 read requests/minute and 5 write requests/minute
 *   - key creation is rate-limited per IP
 *   - authenticated responses expose X-RateLimit-Limit / Remaining / Reset
 *   - 429 responses carry Retry-After
 */

import { sleep, describeFetchError } from './util.js';

const BASE = 'https://api.opensea.io';
const MAX_429_WAIT_SECONDS = 25;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15000;

export class OpenSeaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpenSeaError';
    this.code = code;
  }
}

export class OpenSeaClient {
  constructor({ apiKey = '', debug = false, maxRequests = 40 } = {}) {
    this.apiKey = apiKey;
    this.debug = debug;
    this.maxRequests = maxRequests;
    this.suppliedKey = Boolean(apiKey);
    this.requestsUsed = 0;
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
    this.exhausted = false;
    this.usingTemporaryKey = false;
    this.keyPromise = null;
    this.keyFetchError = null;
    this.keyExpiresAt = null;
    this.cache = new Map();
  }

  log(...args) {
    if (this.debug) console.log('[opensea]', ...args);
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new OpenSeaError(`OpenSea request timed out after ${timeoutMs / 1000}s: ${url}`, 'NETWORK_TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchFreeKey() {
    this.log('creating instant OpenSea API key');
    let res;
    try {
      res = await this.fetchWithTimeout(`${BASE}/api/v2/auth/keys`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      if (err instanceof OpenSeaError) throw err;
      const { code, detail, hint } = describeFetchError(err);
      throw new OpenSeaError(`Could not reach OpenSea to create an instant API key [${code}: ${detail}]. ${hint ? `${hint} ` : ''}Or set OPENSEA_API_KEY from opensea.io -> Settings -> Developer.`, 'KEY_FETCH_FAILED');
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new OpenSeaError('Could not create an instant OpenSea key: rate limited (HTTP 429). OpenSea rate-limits key creation per IP. Set OPENSEA_API_KEY manually from opensea.io -> Settings -> Developer.', 'KEY_RATE_LIMITED');
      }
      throw new OpenSeaError(`Could not create an instant OpenSea key (HTTP ${res.status}). Set OPENSEA_API_KEY manually from opensea.io -> Settings -> Developer.`, 'KEY_FETCH_FAILED');
    }

    const body = await res.json();
    this.log('auth/keys response shape:', Object.keys(body ?? {}));
    const key = body?.api_key ?? body?.key ?? body?.apiKey ?? body?.token;
    const expiresAt = body?.expires_at ?? body?.expiresAt ?? body?.expiry ?? body?.expiration ?? null;
    if (!key || typeof key !== 'string') throw new OpenSeaError(`auth/keys returned no recognisable key. Body keys: ${Object.keys(body ?? {}).join(', ') || 'none'}`, 'KEY_SHAPE_UNEXPECTED');
    this.apiKey = key;
    this.usingTemporaryKey = true;
    this.keyExpiresAt = expiresAt;
    return { key, expiresAt };
  }

  async ensureApiKey() {
    if (this.apiKey) return this.apiKey;
    if (this.keyFetchError) throw this.keyFetchError;
    if (this.keyPromise) return this.keyPromise;
    console.warn('[opensea] No OPENSEA_API_KEY set; creating a temporary instant key. OpenSea free-tier instant keys expire after 30 days and key creation is rate-limited per IP. For production, set OPENSEA_API_KEY.');
    this.keyPromise = this.fetchFreeKey().then(({ key }) => key, (err) => { this.keyFetchError = err; this.keyPromise = null; throw err; });
    return this.keyPromise;
  }

  absorbRateLimitHeaders(res) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rateLimitRemaining = Number(remaining);
    if (reset !== null) this.rateLimitReset = Number(reset);
  }

  async get(path, params = {}, { cache = false, optional = false } = {}) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
    const queryString = query.toString();
    const url = `${BASE}${path}${queryString ? `?${queryString}` : ''}`;
    if (cache && this.cache.has(url)) return this.cache.get(url);
    if (this.exhausted) { if (optional) return null; throw new OpenSeaError('Rate limit budget exhausted for this run.', 'EXHAUSTED'); }
    if (this.requestsUsed >= this.maxRequests) {
      this.exhausted = true;
      if (optional) return null;
      throw new OpenSeaError(`Hit this run's ${this.maxRequests}-request budget. Remaining work resumes next run.`, 'BUDGET');
    }
    await this.ensureApiKey();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.requestsUsed++;
      this.log(`GET ${url} (request ${this.requestsUsed}/${this.maxRequests})`);
      let res;
      try {
        res = await this.fetchWithTimeout(url, { headers: { accept: 'application/json', 'x-api-key': this.apiKey } });
      } catch (err) {
        if (err instanceof OpenSeaError && err.code === 'NETWORK_TIMEOUT') {
          if (attempt < MAX_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
          if (optional) return null;
          throw err;
        }
        if (attempt < MAX_RETRIES) { await sleep(1000 * (attempt + 1)); continue; }
        if (optional) return null;
        const { code, detail, hint } = describeFetchError(err);
        throw new OpenSeaError(`Network error calling ${path} [${code}: ${detail}]${hint ? `. ${hint}` : ''}`, 'NETWORK');
      }

      this.absorbRateLimitHeaders(res);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        if (attempt < MAX_RETRIES && retryAfter <= MAX_429_WAIT_SECONDS) { this.log(`429; waiting ${retryAfter}s before retry`); await sleep(retryAfter * 1000); continue; }
        this.exhausted = true;
        if (optional) return null;
        throw new OpenSeaError(`Rate limited; Retry-After ${retryAfter}s exceeds what this run will wait.`, 'RATE_LIMITED');
      }
      if (res.status === 401 || res.status === 403) {
        if (!this.suppliedKey && attempt < MAX_RETRIES) {
          this.log(`HTTP ${res.status}; temporary key may have expired, creating another instant key`);
          try { await this.fetchFreeKey(); continue; } catch { /* fall through */ }
        }
        if (optional) return null;
        throw new OpenSeaError(`OpenSea rejected the API key (HTTP ${res.status}) on ${path}. If it is an expiring key, replace it and update OPENSEA_API_KEY.`, 'KEY_REJECTED');
      }
      if (res.status === 404) { if (optional) return null; throw new OpenSeaError(`Not found: ${path}`, 'NOT_FOUND'); }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (optional) return null;
        throw new OpenSeaError(`HTTP ${res.status} from ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`, `HTTP_${res.status}`);
      }
      const body = await res.json();
      if (cache) this.cache.set(url, body);
      return body;
    }
    if (optional) return null;
    throw new OpenSeaError(`Gave up on ${path} after ${MAX_RETRIES + 1} attempts.`, 'RETRIES');
  }

  async getDrops({ type = 'upcoming', chains, limit = 50 } = {}) {
    const body = await this.get('/api/v2/drops', { type, chains, limit });
    return Array.isArray(body?.drops) ? body.drops : [];
  }

  async listNewCollections({ chain = 'ethereum', limit = 50 } = {}) {
    const body = await this.get('/api/v2/collections', { chain, order_by: 'created_date', limit });
    return Array.isArray(body?.collections) ? body.collections : [];
  }

  async getCollection(slug) {
    if (!slug) return null;
    return this.get(`/api/v2/collections/${encodeURIComponent(slug)}`, {}, { cache: true, optional: true });
  }

  async getTopHolders(slug, limit = 10) {
    if (!slug) return [];
    const body = await this.get(`/api/v2/collections/${encodeURIComponent(slug)}/holders`, { limit, sort_direction: 'desc' }, { cache: true, optional: true });
    return Array.isArray(body?.holders) ? body.holders : [];
  }

  /** Recent mint events for a collection; used by poll mode to reconstruct demand. */
  async getMintEventsByCollection(slug, { after, limit = 200 } = {}) {
    if (!slug) return [];
    const body = await this.get(`/api/v2/events/collection/${encodeURIComponent(slug)}`, { after, event_type: 'mint', limit }, { cache: false, optional: true });
    return Array.isArray(body?.asset_events) ? body.asset_events : (Array.isArray(body?.events) ? body.events : []);
  }
}
