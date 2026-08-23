/**
 * OpenSea REST client.
 *
 * Built around the free tier's real constraints, all verified against
 * docs.opensea.io:
 *   - roughly 600 reads/hour on a token bucket
 *   - X-RateLimit-Limit / -Remaining / -Reset on every authenticated response
 *   - 429 responses carry Retry-After in seconds
 *   - POST /api/v2/auth/keys mints a free key instantly, but it expires in 7 days
 *
 * A poll run gets a hard request budget so twelve runs an hour cannot exhaust
 * the bucket. When the budget or the bucket runs dry we stop cleanly rather
 * than hammering the API: the next run five minutes later picks up where this
 * one left off.
 */

import { sleep, describeFetchError } from './util.js';

const BASE = 'https://api.opensea.io';
const MAX_429_WAIT_SECONDS = 25;
const MAX_RETRIES = 2;

export class OpenSeaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpenSeaError';
    this.code = code;
  }
}

export class OpenSeaClient {
  /**
   * @param {object} options
   * @param {string} [options.apiKey] Existing key. If omitted, a free one is fetched.
   * @param {boolean} [options.debug]
   * @param {number} [options.maxRequests] Request budget for this run.
   */
  constructor({ apiKey = '', debug = false, maxRequests = 40 } = {}) {
    this.apiKey = apiKey;
    this.debug = debug;
    this.maxRequests = maxRequests;

    this.requestsUsed = 0;
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
    this.exhausted = false;
    this.usingTemporaryKey = false;

    /** In-flight key mint, so concurrent callers share one request. */
    this.keyPromise = null;
    /** A failed mint, remembered so we do not retry a dead key service per call. */
    this.keyFetchError = null;
    this.keyExpiresAt = null;

    /** Per-process response cache. Poll runs are short, so in-memory is enough. */
    this.cache = new Map();
  }

  log(...args) {
    if (this.debug) console.log('[opensea]', ...args);
  }

  /**
   * Mint a free API key. No signup, no wallet, no approval — but it expires in
   * 7 days, so this is a convenience for local testing rather than the way to
   * run in production. Set OPENSEA_API_KEY to a permanent key instead.
   */
  async fetchFreeKey() {
    let res;
    try {
      res = await fetch(`${BASE}/api/v2/auth/keys`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      // Unwrapped, this surfaces as Node's bare "fetch failed", which tells the
      // user nothing about what to do next. The real reason lives in err.cause.
      const { code, detail, hint } = describeFetchError(err);
      throw new OpenSeaError(
        `Could not reach OpenSea to mint an API key [${code}: ${detail}]. ` +
          (hint ? `${hint} ` : '') +
          `Or set OPENSEA_API_KEY from opensea.io -> Settings -> Developer.`,
        'KEY_FETCH_FAILED'
      );
    }

    if (!res.ok) {
      // 429 here is special and worth its own message. This endpoint is rate
      // limited per IP, and CI runners share their IPs with a very large number
      // of other users — so on GitHub Actions the quota is usually already spent
      // by a stranger before the job starts. Retrying or slowing the cron cannot
      // fix it, because it was never our quota. A real key is the only way out.
      if (res.status === 429) {
        throw new OpenSeaError(
          'Could not mint a free OpenSea key: rate limited (HTTP 429). ' +
            'This endpoint is limited per IP address, and CI runners share IPs with many ' +
            'other users, so the free-key quota is normally already exhausted there. ' +
            'Waiting will not help. Set the OPENSEA_API_KEY secret to a key from ' +
            'opensea.io -> Settings -> Developer.',
          'KEY_RATE_LIMITED'
        );
      }

      throw new OpenSeaError(
        `Could not mint a free OpenSea key (HTTP ${res.status}). ` +
          `Set OPENSEA_API_KEY manually from opensea.io -> Settings -> Developer.`,
        'KEY_FETCH_FAILED'
      );
    }

    const body = await res.json();
    this.log('auth/keys response shape:', Object.keys(body ?? {}));

    // The exact field name is not guaranteed stable, so accept the plausible
    // variants rather than breaking on a rename.
    const key = body?.key ?? body?.api_key ?? body?.apiKey ?? body?.token;
    const expiresAt =
      body?.expires_at ?? body?.expiresAt ?? body?.expiry ?? body?.expiration ?? null;

    if (!key || typeof key !== 'string') {
      throw new OpenSeaError(
        `auth/keys returned no recognisable key. Body keys: ${Object.keys(body ?? {}).join(', ') || 'none'}`,
        'KEY_SHAPE_UNEXPECTED'
      );
    }

    this.apiKey = key;
    this.usingTemporaryKey = true;
    this.keyExpiresAt = expiresAt;
    return { key, expiresAt };
  }

  /**
   * Get a usable key, minting one at most ONCE per run.
   *
   * The memoisation matters in both directions. On success it stops us minting a
   * key per collector. On failure it stops us retrying a dead key service on
   * every request path — which also printed the "minting a temporary key"
   * warning three times per run, implying three keys had been created when none
   * had.
   */
  async ensureApiKey() {
    if (this.apiKey) return this.apiKey;
    if (this.keyFetchError) throw this.keyFetchError;
    if (this.keyPromise) return this.keyPromise;

    console.warn(
      '[opensea] No OPENSEA_API_KEY set; minting a temporary free key. ' +
        'These expire in 7 days and each run mints a new one — set a permanent key for real use.'
    );

    this.keyPromise = this.fetchFreeKey().then(
      ({ key }) => key,
      (err) => {
        // Remember the failure so the next caller fails fast and quietly.
        this.keyFetchError = err;
        this.keyPromise = null;
        throw err;
      }
    );

    return this.keyPromise;
  }

  /** Record quota state from response headers so we can stop before a 429. */
  absorbRateLimitHeaders(res) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rateLimitRemaining = Number(remaining);
    if (reset !== null) this.rateLimitReset = Number(reset);
  }

  /**
   * GET a path with the API key attached.
   * @param {string} path e.g. `/api/v2/drops`
   * @param {Record<string, string|number|undefined>} [params]
   * @param {object} [options]
   * @param {boolean} [options.cache] Reuse an identical response within this run.
   * @param {boolean} [options.optional] Return null on failure instead of throwing.
   */
  async get(path, params = {}, { cache = false, optional = false } = {}) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
    }
    // `.toString()` rather than `.size`: URLSearchParams#size is Node 19+.
    const queryString = query.toString();
    const url = `${BASE}${path}${queryString ? `?${queryString}` : ''}`;

    if (cache && this.cache.has(url)) return this.cache.get(url);

    if (this.exhausted) {
      if (optional) return null;
      throw new OpenSeaError('Rate limit budget exhausted for this run.', 'EXHAUSTED');
    }

    if (this.requestsUsed >= this.maxRequests) {
      this.exhausted = true;
      if (optional) return null;
      throw new OpenSeaError(
        `Hit this run's ${this.maxRequests}-request budget. Remaining work resumes next run.`,
        'BUDGET'
      );
    }

    await this.ensureApiKey();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.requestsUsed++;
      this.log(`GET ${url} (request ${this.requestsUsed}/${this.maxRequests})`);

      let res;
      try {
        res = await fetch(url, {
          headers: { accept: 'application/json', 'x-api-key': this.apiKey },
        });
      } catch (err) {
        // Network blip. Retry with a short backoff, then give up.
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (optional) return null;
        const { code, detail, hint } = describeFetchError(err);
        throw new OpenSeaError(
          `Network error calling ${path} [${code}: ${detail}]${hint ? `. ${hint}` : ''}`,
          'NETWORK'
        );
      }

      this.absorbRateLimitHeaders(res);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        if (attempt < MAX_RETRIES && retryAfter <= MAX_429_WAIT_SECONDS) {
          this.log(`429; waiting ${retryAfter}s before retry`);
          await sleep(retryAfter * 1000);
          continue;
        }
        // Waiting longer than this would risk the CI job timing out.
        this.exhausted = true;
        if (optional) return null;
        throw new OpenSeaError(
          `Rate limited; Retry-After ${retryAfter}s exceeds what this run will wait.`,
          'RATE_LIMITED'
        );
      }

      // An expired or revoked key: mint a fresh one and retry once.
      if ((res.status === 401 || res.status === 403) && attempt < MAX_RETRIES) {
        this.log(`HTTP ${res.status}; key may have expired, minting a new one`);
        try {
          await this.fetchFreeKey();
          continue;
        } catch {
          // Fall through to the generic error below.
        }
      }

      if (res.status === 404) {
        if (optional) return null;
        throw new OpenSeaError(`Not found: ${path}`, 'NOT_FOUND');
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (optional) return null;
        throw new OpenSeaError(
          `HTTP ${res.status} from ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          `HTTP_${res.status}`
        );
      }

      const body = await res.json();
      if (cache) this.cache.set(url, body);
      return body;
    }

    if (optional) return null;
    throw new OpenSeaError(`Gave up on ${path} after ${MAX_RETRIES + 1} attempts.`, 'RETRIES');
  }

  // --- Endpoints -----------------------------------------------------------

  /**
   * The drop calendar. `upcoming` is the valuable one: it carries a future
   * `next_stage.start_time`, which is how we warn you before a mint opens
   * rather than after.
   * @param {'upcoming'|'recently_minted'|'featured'} type
   */
  async getDrops({ type = 'upcoming', chains, limit = 50 } = {}) {
    const body = await this.get('/api/v2/drops', { type, chains, limit });
    return Array.isArray(body?.drops) ? body.drops : [];
  }

  /** Newest collections registered on OpenSea, before they have any volume. */
  async listNewCollections({ chain = 'ethereum', limit = 50 } = {}) {
    const body = await this.get('/api/v2/collections', {
      chain,
      order_by: 'created_date',
      limit,
    });
    return Array.isArray(body?.collections) ? body.collections : [];
  }

  /**
   * Full collection detail: total_supply, created_date, safelist_status,
   * socials, is_nsfw, is_disabled. Cached because it barely changes.
   */
  async getCollection(slug) {
    if (!slug) return null;
    return this.get(`/api/v2/collections/${encodeURIComponent(slug)}`, {}, {
      cache: true,
      optional: true,
    });
  }

  /**
   * Top holders, descending. Each entry carries `percentage` directly, which is
   * exactly what the concentration check needs — no tallying required.
   */
  async getTopHolders(slug, limit = 10) {
    if (!slug) return [];
    const body = await this.get(
      `/api/v2/collections/${encodeURIComponent(slug)}/holders`,
      { limit, sort_direction: 'desc' },
      { cache: true, optional: true }
    );
    return Array.isArray(body?.holders) ? body.holders : [];
  }
}
