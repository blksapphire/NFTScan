/** Secondary-market metrics. Works with whatever REST source supplies sales/listing data. */

export function analyseMarket(snapshot = {}, previous = null) {
  const floor = num(snapshot.floorEth);
  const volume = num(snapshot.volumeEth);
  const listings = num(snapshot.listings);
  const sales = num(snapshot.sales);
  const buyers = num(snapshot.uniqueBuyers);
  const sellers = num(snapshot.uniqueSellers);
  const out = { floorEth: floor, volumeEth: volume, listings, sales, uniqueBuyers: buyers, uniqueSellers: sellers };

  if (previous) {
    const pf = num(previous.floorEth);
    const pv = num(previous.volumeEth);
    if (Number.isFinite(floor) && Number.isFinite(pf) && pf > 0) out.floorChangePct = ((floor - pf) / pf) * 100;
    if (Number.isFinite(volume) && Number.isFinite(pv) && pv > 0) out.volumeChangePct = ((volume - pv) / pv) * 100;
  }
  if (Number.isFinite(listings) && Number.isFinite(snapshot.supply) && Number(snapshot.supply) > 0) out.listingRatio = listings / Number(snapshot.supply);
  if (Number.isFinite(buyers) && Number.isFinite(sellers) && sellers > 0) out.buyerSellerRatio = buyers / sellers;
  return out;
}

export function outcomeFromMint({ mintPriceEth, snapshot }) {
  const mint = num(mintPriceEth);
  const floor = num(snapshot?.floorEth);
  const maxFloor = num(snapshot?.maxFloorEth ?? snapshot?.floorEth);
  const drawdown = num(snapshot?.drawdownPct);
  const returnPct = Number.isFinite(mint) && mint > 0 && Number.isFinite(floor) ? ((floor - mint) / mint) * 100 : null;
  return { floorEth: floor, maxFloorEth: maxFloor, returnPct, drawdownPct: drawdown };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
