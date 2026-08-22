/**
 * Real-time mint detection (stream mode).
 *
 * OpenSea's Stream API has no "mint" event and no "new collection" event. But a
 * mint is definitionally a transfer out of the zero address, so subscribing to
 * `item_transferred` across all collections and filtering on
 * `from_account == 0x0000...0000` gives chain-wide mint detection. Streamed
 * events are exempt from REST rate limits, so this costs nothing against quota.
 *
 * Events per contract go into a rolling time window, from which we derive the
 * two numbers the screener cares most about: mints per minute, and how many
 * distinct wallets are doing the minting.
 */

const DEFAULT_WINDOW_MINUTES = 10;
/** Ceiling on tracked contracts so a long-running process cannot grow forever. */
const MAX_TRACKED_CONTRACTS = 4000;

export class MintTracker {
  constructor({ windowMinutes = DEFAULT_WINDOW_MINUTES, minMints = 12, minUniqueMinters = 8 } = {}) {
    this.windowMs = windowMinutes * 60000;
    this.minMints = minMints;
    this.minUniqueMinters = minUniqueMinters;
    /** @type {Map<string, {firstSeenMs: number, slug: string|null, name: string|null, events: Array<{to: string, at: number}>}>} */
    this.contracts = new Map();
  }

  /**
   * @param {object} mint
   * @param {string} mint.contractAddress
   * @param {string} mint.toAddress   the minter
   * @param {number} mint.atMs        from event_timestamp, since ordering is not guaranteed
   */
  record({ contractAddress, toAddress, atMs, slug = null, name = null }) {
    if (!contractAddress || !Number.isFinite(atMs)) return;
    const key = String(contractAddress).toLowerCase();

    let entry = this.contracts.get(key);
    if (!entry) {
      // Evict the oldest tracked contract if we are at the ceiling.
      if (this.contracts.size >= MAX_TRACKED_CONTRACTS) {
        const oldest = this.contracts.keys().next().value;
        this.contracts.delete(oldest);
      }
      entry = { firstSeenMs: atMs, slug, name, events: [] };
      this.contracts.set(key, entry);
    }

    if (slug && !entry.slug) entry.slug = slug;
    if (name && !entry.name) entry.name = name;
    if (atMs < entry.firstSeenMs) entry.firstSeenMs = atMs;

    entry.events.push({ to: String(toAddress || '').toLowerCase(), at: atMs });
  }

  /** Drop events that have aged out of the window, and contracts left empty. */
  prune(nowMs = Date.now()) {
    const cutoff = nowMs - this.windowMs;
    for (const [key, entry] of this.contracts) {
      entry.events = entry.events.filter((e) => e.at >= cutoff);
      if (entry.events.length === 0) this.contracts.delete(key);
    }
  }

  /** Window statistics for one contract. */
  stats(contractAddress, nowMs = Date.now()) {
    const entry = this.contracts.get(String(contractAddress).toLowerCase());
    if (!entry) return null;

    const cutoff = nowMs - this.windowMs;
    const inWindow = entry.events.filter((e) => e.at >= cutoff);
    if (inWindow.length === 0) return null;

    const uniqueMinters = new Set(inWindow.map((e) => e.to)).size;
    const earliest = Math.min(...inWindow.map((e) => e.at));

    // Measure over observed elapsed time, not the nominal window: a mint that
    // started 90 seconds ago should not be divided by ten minutes.
    const elapsedMinutes = Math.max(0.5, (nowMs - earliest) / 60000);

    return {
      contractAddress: String(contractAddress).toLowerCase(),
      slug: entry.slug,
      name: entry.name,
      totalMints: inWindow.length,
      uniqueMinters,
      mintsPerMinute: inWindow.length / elapsedMinutes,
      firstSeenMs: entry.firstSeenMs,
      windowMinutes: this.windowMs / 60000,
    };
  }

  /**
   * Contracts that have crossed the activity thresholds and are therefore worth
   * spending API requests to enrich and score.
   */
  hot(nowMs = Date.now()) {
    const out = [];
    for (const key of this.contracts.keys()) {
      const s = this.stats(key, nowMs);
      if (!s) continue;
      if (s.totalMints < this.minMints) continue;
      if (s.uniqueMinters < this.minUniqueMinters) continue;
      out.push(s);
    }
    // Busiest first, so a request budget is spent on the strongest signals.
    return out.sort((a, b) => b.mintsPerMinute - a.mintsPerMinute);
  }
}

/**
 * Pull the fields we need out of an `item_transferred` payload, tolerating the
 * shape variations between the SDK and the raw socket.
 * @returns {{contractAddress: string, toAddress: string, fromAddress: string, atMs: number, slug: string|null, name: string|null}|null}
 */
export function parseTransferEvent(payload) {
  const item = payload?.item ?? {};
  const fromAddress = payload?.from_account?.address ?? payload?.from_account ?? null;
  const toAddress = payload?.to_account?.address ?? payload?.to_account ?? null;

  // nft_id looks like "ethereum/0xcontract/1234"
  const nftId = String(item?.nft_id ?? '');
  const parts = nftId.split('/');
  const contractAddress =
    payload?.contract_address ??
    item?.contract_address ??
    (parts.length >= 2 ? parts[1] : null);

  const atMs = Date.parse(payload?.event_timestamp ?? '');

  if (!contractAddress) return null;

  return {
    contractAddress: String(contractAddress).toLowerCase(),
    fromAddress: fromAddress ? String(fromAddress).toLowerCase() : null,
    toAddress: toAddress ? String(toAddress).toLowerCase() : null,
    // Fall back to arrival time if the timestamp is missing or malformed.
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
    slug: payload?.collection?.slug ?? null,
    name: item?.metadata?.name ?? null,
  };
}
