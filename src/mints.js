/** Real-time mint detection with rolling velocity and acceleration metrics. */

const DEFAULT_WINDOW_MINUTES = 10;
const MAX_TRACKED_CONTRACTS = 4000;

export class MintTracker {
  constructor({ windowMinutes = DEFAULT_WINDOW_MINUTES, minMints = 12, minUniqueMinters = 8 } = {}) {
    this.windowMs = windowMinutes * 60000;
    this.minMints = minMints;
    this.minUniqueMinters = minUniqueMinters;
    this.contracts = new Map();
  }

  record({ contractAddress, toAddress, atMs, slug = null, name = null }) {
    if (!contractAddress || !Number.isFinite(atMs)) return;
    const key = String(contractAddress).toLowerCase();
    let entry = this.contracts.get(key);
    if (!entry) {
      if (this.contracts.size >= MAX_TRACKED_CONTRACTS) this.contracts.delete(this.contracts.keys().next().value);
      entry = { firstSeenMs: atMs, slug, name, events: [] };
      this.contracts.set(key, entry);
    }
    if (slug && !entry.slug) entry.slug = slug;
    if (name && !entry.name) entry.name = name;
    if (atMs < entry.firstSeenMs) entry.firstSeenMs = atMs;
    entry.events.push({ to: String(toAddress || '').toLowerCase(), at: atMs });
  }

  prune(nowMs = Date.now()) {
    const cutoff = nowMs - this.windowMs;
    for (const [key, entry] of this.contracts) {
      entry.events = entry.events.filter((e) => e.at >= cutoff);
      if (!entry.events.length) this.contracts.delete(key);
    }
  }

  stats(contractAddress, nowMs = Date.now()) {
    const entry = this.contracts.get(String(contractAddress).toLowerCase());
    if (!entry) return null;
    const cutoff = nowMs - this.windowMs;
    const events = entry.events.filter((e) => e.at >= cutoff).sort((a, b) => a.at - b.at);
    if (!events.length) return null;
    const uniqueMinters = new Set(events.map((e) => e.to)).size;
    const earliest = events[0].at;
    const elapsedMinutes = Math.max(0.5, (nowMs - earliest) / 60000);
    const currentVelocity = events.length / elapsedMinutes;

    // Compare the newest half of the window against the older half. This makes
    // acceleration robust to collections whose mint began at different times.
    const midpoint = cutoff + this.windowMs / 2;
    const oldEvents = events.filter((e) => e.at < midpoint);
    const newEvents = events.filter((e) => e.at >= midpoint);
    const oldMinutes = Math.max(0.5, (midpoint - Math.max(cutoff, oldEvents[0]?.at ?? midpoint)) / 60000);
    const newMinutes = Math.max(0.5, (nowMs - Math.max(midpoint, newEvents[0]?.at ?? nowMs)) / 60000);
    const previousVelocity = oldEvents.length ? oldEvents.length / oldMinutes : currentVelocity;
    const acceleration = previousVelocity > 0 ? (currentVelocity - previousVelocity) / previousVelocity : 0;

    return {
      contractAddress: String(contractAddress).toLowerCase(),
      slug: entry.slug,
      name: entry.name,
      totalMints: events.length,
      uniqueMinters,
      mintsPerMinute: currentVelocity,
      previousMintsPerMinute: previousVelocity,
      acceleration,
      firstSeenMs: entry.firstSeenMs,
      windowMinutes: this.windowMs / 60000,
    };
  }

  hot(nowMs = Date.now()) {
    const out = [];
    for (const key of this.contracts.keys()) {
      const s = this.stats(key, nowMs);
      if (!s || s.totalMints < this.minMints || s.uniqueMinters < this.minUniqueMinters) continue;
      out.push(s);
    }
    return out.sort((a, b) => (b.mintsPerMinute + Math.max(0, b.acceleration) * 10) - (a.mintsPerMinute + Math.max(0, a.acceleration) * 10));
  }
}

export function parseTransferEvent(payload) {
  const item = payload?.item ?? {};
  const fromAddress = payload?.from_account?.address ?? payload?.from_account ?? null;
  const toAddress = payload?.to_account?.address ?? payload?.to_account ?? null;
  const nftId = String(item?.nft_id ?? '');
  const parts = nftId.split('/');
  const contractAddress = payload?.contract_address ?? item?.contract_address ?? (parts.length >= 2 ? parts[1] : null);
  const atMs = Date.parse(payload?.event_timestamp ?? '');
  if (!contractAddress) return null;
  return {
    contractAddress: String(contractAddress).toLowerCase(),
    fromAddress: fromAddress ? String(fromAddress).toLowerCase() : null,
    toAddress: toAddress ? String(toAddress).toLowerCase() : null,
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
    slug: payload?.collection?.slug ?? null,
    name: item?.metadata?.name ?? null,
  };
}
