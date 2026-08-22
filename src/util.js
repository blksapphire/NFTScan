/**
 * Small shared helpers. No dependencies.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** A mint is a transfer that originates from nowhere. */
export function isMintTransfer(fromAddress) {
  if (!fromAddress) return false;
  return String(fromAddress).toLowerCase() === ZERO_ADDRESS;
}

/**
 * Wei (decimal string) -> ETH number. OpenSea returns mint prices as wei
 * strings, which exceed Number's safe integer range, so parse via BigInt.
 * @param {string|number|bigint|null|undefined} wei
 * @returns {number|null} ETH, or null if unparseable
 */
export function weiToEth(wei) {
  if (wei === null || wei === undefined || wei === '') return null;
  try {
    const asBigInt = BigInt(String(wei).trim());
    if (asBigInt === 0n) return 0;
    // Keep 6 decimal places of precision without floating-point drift.
    const scaled = (asBigInt * 1000000n) / 1000000000000000000n;
    return Number(scaled) / 1000000;
  } catch {
    return null;
  }
}

export function formatEth(eth) {
  if (eth === null || eth === undefined) return 'unknown';
  if (eth === 0) return 'FREE';
  if (eth < 0.001) return `${eth.toFixed(6)} ETH`;
  if (eth < 1) return `${eth.toFixed(4)} ETH`;
  return `${eth.toFixed(3)} ETH`;
}

/** "in 2h 14m" / "3m ago" — humans read relative time faster than timestamps. */
export function formatRelative(targetMs, nowMs = Date.now()) {
  if (!Number.isFinite(targetMs)) return 'unknown';
  const deltaSec = Math.round((targetMs - nowMs) / 1000);
  const abs = Math.abs(deltaSec);

  const parts = [];
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${abs}s`);

  const joined = parts.slice(0, 2).join(' ');
  return deltaSec >= 0 ? `in ${joined}` : `${joined} ago`;
}

export function hoursBetween(aMs, bMs) {
  return Math.abs(aMs - bMs) / 3600000;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp to 0..1, treating non-numbers as 0. Used all over the scorer. */
export function unit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Linear score: 0 below `min`, 1 above `max`, proportional in between.
 * Reads more clearly at each call site than an inline ternary chain.
 */
export function ramp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (max === min) return n >= max ? 1 : 0;
  return unit((n - min) / (max - min));
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function shortAddress(address) {
  const a = String(address ?? '');
  if (a.length < 12) return a || 'unknown';
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}
