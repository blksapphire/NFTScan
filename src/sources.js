/**
 * Turning OpenSea responses into scoreable candidates.
 *
 * The pipeline is deliberately ordered to protect the request budget:
 *
 *   1. LIST   - three cheap list calls (upcoming drops, recently minted, new collections)
 *   2. FILTER - discard on list data alone: wrong chain, already alerted, outside
 *               the lead-time window. This is where ~95% of rows die, for free.
 *   3. ENRICH - only survivors get the expensive per-collection detail and
 *               holder calls, capped so one busy run cannot drain the hour's quota.
 *
 * Doing it the other way round — enriching everything then filtering — would
 * burn the whole 600/hour bucket in a couple of runs.
 */

import { weiToEth, ZERO_ADDRESS } from './util.js';
import { wasAlerted } from './state.js';

/**
 * Which lead-time bucket, if any, this drop has just crossed into.
 * With leadTimeMinutes [180, 25] you get a research heads-up ~3h out and a
 * get-ready ping ~25m out, and never more than one of each.
 * @returns {number|null} the bucket in minutes, or null if none is due
 */
export function dueLeadBucket(startTimeMs, leadTimes, state, contractAddress, nowMs) {
  if (!Number.isFinite(startTimeMs) || startTimeMs <= nowMs) return null;
  const minutesUntil = (startTimeMs - nowMs) / 60000;

  // Ascending, so the tightest (most urgent) unfired bucket wins.
  const buckets = [...leadTimes].map(Number).filter(Number.isFinite).sort((a, b) => a - b);

  for (const bucket of buckets) {
    if (minutesUntil <= bucket && !wasAlerted(state, contractAddress, `upcoming-${bucket}`)) {
      return bucket;
    }
  }
  return null;
}

function socialsFrom(collection) {
  if (!collection) return {};
  return {
    twitter: collection.twitter_username || null,
    discord: collection.discord_url || null,
    telegram: collection.telegram_url || null,
    website: collection.project_url || null,
  };
}

function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The stage that matters: whichever one is live, else the next scheduled. */
function relevantStage(drop) {
  return drop?.active_stage || drop?.next_stage || null;
}

/**
 * @param {object} drop  a DropResponse
 * @param {number} nowMs
 */
function candidateFromDrop(drop, nowMs) {
  const stage = relevantStage(drop);
  const startTimeMs = parseDate(stage?.start_time);
  const priceEth = weiToEth(stage?.price);
  const currency = String(stage?.price_currency_address || ZERO_ADDRESS).toLowerCase();

  return {
    kind: drop.is_minting ? 'live' : 'upcoming',
    source: drop.is_minting ? 'drops:minting' : 'drops:upcoming',
    contractAddress: drop.contract_address || null,
    slug: drop.collection_slug || null,
    name: drop.collection_name || drop.collection_slug || 'Unnamed collection',
    chain: drop.chain || null,
    imageUrl: drop.image_url || null,
    openseaUrl: drop.opensea_url || null,
    dropType: drop.drop_type || null,

    mintPriceEth: priceEth,
    isNativeCurrency: currency === ZERO_ADDRESS,
    maxPerWallet: Number.isFinite(Number(stage?.max_per_wallet))
      ? Number(stage.max_per_wallet)
      : null,
    stageLabel: stage?.label || stage?.stage_type || null,
    startTimeMs,
    endTimeMs: parseDate(stage?.end_time),

    // Filled in by enrich().
    totalSupply: null,
    createdAtMs: null,
    safelistStatus: null,
    socials: {},
    isNsfw: false,
    isDisabled: false,
    description: null,
    topHolders: null,

    // Only stream mode can observe these.
    uniqueMinters: null,
    totalMints: null,
    mintsPerMinute: null,

    detectedAtMs: nowMs,
  };
}

function candidateFromCollection(collection, nowMs) {
  const contract = Array.isArray(collection?.contracts) ? collection.contracts[0] : null;
  return {
    kind: 'new_collection',
    source: 'collections:created_date',
    contractAddress: contract?.address || null,
    slug: collection.collection || collection.slug || null,
    name: collection.name || collection.collection || 'Unnamed collection',
    chain: contract?.chain || null,
    imageUrl: collection.image_url || null,
    openseaUrl: collection.opensea_url || null,
    dropType: null,

    mintPriceEth: null,
    isNativeCurrency: true,
    maxPerWallet: null,
    stageLabel: null,
    startTimeMs: null,
    endTimeMs: null,

    totalSupply: Number.isFinite(Number(collection.total_supply))
      ? Number(collection.total_supply)
      : null,
    createdAtMs: parseDate(collection.created_date),
    safelistStatus: collection.safelist_status || null,
    socials: socialsFrom(collection),
    isNsfw: Boolean(collection.is_nsfw),
    isDisabled: Boolean(collection.is_disabled),
    description: collection.description || null,
    topHolders: null,

    uniqueMinters: null,
    totalMints: null,
    mintsPerMinute: null,

    detectedAtMs: nowMs,
  };
}

/**
 * Add the fields that need extra API calls. Costs one or two requests per
 * candidate, which is why only pre-filtered survivors get here.
 *
 * `optional: true` on the underlying calls means enrichment degrades rather
 * than throws: a candidate with partial data still scores, just over fewer
 * components.
 */
export async function enrich(client, candidate, { withHolders = true } = {}) {
  if (!candidate.slug) return candidate;

  const collection = await client.getCollection(candidate.slug);
  if (collection) {
    candidate.totalSupply = Number.isFinite(Number(collection.total_supply))
      ? Number(collection.total_supply)
      : candidate.totalSupply;
    candidate.createdAtMs = parseDate(collection.created_date) ?? candidate.createdAtMs;
    candidate.safelistStatus = collection.safelist_status ?? candidate.safelistStatus;
    candidate.socials = { ...candidate.socials, ...socialsFrom(collection) };
    candidate.isNsfw = Boolean(collection.is_nsfw);
    candidate.isDisabled = Boolean(collection.is_disabled);
    candidate.description = collection.description || candidate.description;
    candidate.openseaUrl = candidate.openseaUrl || collection.opensea_url || null;
    candidate.uniqueItemCount = Number.isFinite(Number(collection.unique_item_count))
      ? Number(collection.unique_item_count)
      : null;

    if (!candidate.contractAddress && Array.isArray(collection.contracts)) {
      candidate.contractAddress = collection.contracts[0]?.address || null;
    }
  }

  // An upcoming mint has no holders yet, so skip the call entirely.
  if (withHolders && candidate.kind !== 'upcoming') {
    const holders = await client.getTopHolders(candidate.slug, 10);
    if (holders.length) candidate.topHolders = holders;
  }

  return candidate;
}

// --- Source collectors -----------------------------------------------------

/**
 * Upcoming drops: the highest-value signal, because `next_stage.start_time` is
 * in the future. That is what makes a 5-minute polling cadence viable — we are
 * warning you hours ahead, so a late cron run costs nothing.
 */
export async function collectUpcoming(client, cfg, state, nowMs) {
  const drops = await client.getDrops({ type: 'upcoming', chains: cfg.chain, limit: 50 });
  const out = [];

  for (const drop of drops) {
    if (cfg.chain && drop.chain && drop.chain !== cfg.chain) continue;

    const candidate = candidateFromDrop(drop, nowMs);
    if (!candidate.contractAddress) continue;

    const bucket = dueLeadBucket(
      candidate.startTimeMs,
      cfg.leadTimeMinutes || [180, 25],
      state,
      candidate.contractAddress,
      nowMs
    );
    if (bucket === null) continue;

    candidate.kind = 'upcoming';
    candidate.alertKind = `upcoming-${bucket}`;
    candidate.leadBucketMinutes = bucket;
    out.push(candidate);
  }

  return out;
}

/** Mints that have already opened. The catch-up path for anything the lead-time alerts missed. */
export async function collectLive(client, cfg, state, nowMs) {
  const drops = await client.getDrops({ type: 'recently_minted', chains: cfg.chain, limit: 50 });
  const out = [];

  for (const drop of drops) {
    if (cfg.chain && drop.chain && drop.chain !== cfg.chain) continue;

    const candidate = candidateFromDrop(drop, nowMs);
    if (!candidate.contractAddress) continue;
    if (wasAlerted(state, candidate.contractAddress, 'live')) continue;

    candidate.kind = 'live';
    candidate.alertKind = 'live';
    out.push(candidate);
  }

  return out;
}

/** Brand-new collections, before they have any volume at all. */
export async function collectNewCollections(client, cfg, state, nowMs) {
  const collections = await client.listNewCollections({ chain: cfg.chain, limit: 50 });
  const out = [];

  for (const collection of collections) {
    const candidate = candidateFromCollection(collection, nowMs);
    if (!candidate.contractAddress && !candidate.slug) continue;

    const dedupeId = candidate.contractAddress || candidate.slug;
    if (wasAlerted(state, dedupeId, 'new_collection')) continue;

    // Cheap age check before spending a request on enrichment.
    const maxAge = Number(cfg.freshness?.maxCollectionAgeHours) || 72;
    if (Number.isFinite(candidate.createdAtMs)) {
      const ageHours = (nowMs - candidate.createdAtMs) / 3600000;
      if (ageHours > maxAge) continue;
    }

    candidate.alertKind = 'new_collection';
    out.push(candidate);
  }

  return out;
}
