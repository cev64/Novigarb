// Arbitrage math.
//
// Both venues trade binary contracts that pay $1 on settlement, so a cross-book lock is
// simply: buy N contracts of a proposition on one book and N contracts of its complement
// on the other. Payout is exactly N whichever way it settles, and
//     profit = N - costA - costB - feesA - feesB.
//
// Prices come from walking each book's ask ladder, so the numbers reflect what N
// contracts would actually cost rather than the top-of-book headline.

import { config } from './config.js';
import { kalshiFee, seriesFeeMultiplier } from './kalshi.js';
import { novigFee } from './novig.js';
import { round, formatAmerican } from './util.js';

/** Walk an ask ladder for `contracts`, returning what actually fills and at what cost. */
export function fillCost(ladder, contracts) {
  let remaining = contracts;
  let cost = 0;
  let filled = 0;

  for (const level of ladder) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    cost += take * level.price;
    filled += take;
    remaining -= take;
  }

  return { filled, cost, vwap: filled > 0 ? cost / filled : null };
}

export function ladderDepth(ladder) {
  return ladder.reduce((sum, l) => sum + l.size, 0);
}

/** Fee for one leg at a given size and average price. */
function legFee(leg, contracts, price) {
  if (leg.book === 'kalshi') {
    return kalshiFee(contracts, price, seriesFeeMultiplier(leg.seriesTicker));
  }
  return novigFee(contracts, price, leg.isLive);
}

/**
 * Price a two-leg cross-book lock.
 *
 * `anchor` decides which leg is sized to `targetStake`:
 *   'larger'  - the more expensive leg, so no single leg exceeds the target (default)
 *   'kalshi' | 'novig' - pin that book's leg
 *
 * Returns null when the legs cannot be sized at all.
 */
export function priceArb({ legA, legB, ladderA, ladderB, targetStake, anchor = 'larger' }) {
  if (!ladderA.length || !ladderB.length) return null;

  const topA = ladderA[0].price;
  const topB = ladderB[0].price;
  if (topA + topB <= 0) return null;

  const depthCap = Math.min(ladderDepth(ladderA), ladderDepth(ladderB));
  if (depthCap <= 0) return null;

  // Which leg carries the target stake.
  let anchorIsA;
  if (anchor === 'kalshi') anchorIsA = legA.book === 'kalshi';
  else if (anchor === 'novig') anchorIsA = legA.book === 'novig';
  else anchorIsA = topA >= topB;

  // Size so the anchor leg's stake lands on the target, then cap by depth.
  // Two passes: the first uses top-of-book, the second corrects for slippage.
  let contracts = targetStake / (anchorIsA ? topA : topB);
  contracts = Math.min(contracts, depthCap);

  for (let pass = 0; pass < 2; pass++) {
    const probe = fillCost(anchorIsA ? ladderA : ladderB, contracts);
    if (!probe.vwap) return null;
    const retargeted = Math.min(targetStake / probe.vwap, depthCap);
    if (Math.abs(retargeted - contracts) < 0.01) break;
    contracts = retargeted;
  }

  // Trade in whole contracts — that is what both venues quote sizes in.
  contracts = Math.floor(Math.min(contracts, depthCap));
  if (contracts < 1) return null;

  const fillA = fillCost(ladderA, contracts);
  const fillB = fillCost(ladderB, contracts);
  if (fillA.filled < contracts - 1e-6 || fillB.filled < contracts - 1e-6) return null;

  const feeA = legFee(legA, contracts, fillA.vwap);
  const feeB = legFee(legB, contracts, fillB.vwap);

  const stake = fillA.cost + fillB.cost;
  const totalCost = stake + feeA + feeB;
  const payout = contracts;
  const profit = payout - totalCost;

  const grossEdge = 1 - (fillA.vwap + fillB.vwap);
  const netRoi = totalCost > 0 ? profit / totalCost : 0;

  return {
    contracts,
    payout: round(payout, 2),
    stake: round(stake, 2),
    fees: round(feeA + feeB, 4),
    totalCost: round(totalCost, 2),
    profit: round(profit, 2),
    grossEdge,
    netRoi,
    topEdge: 1 - (topA + topB),
    depthCap: round(depthCap, 2),
    legs: [
      buildLegView(legA, fillA, feeA, contracts),
      buildLegView(legB, fillB, feeB, contracts),
    ],
  };
}

function buildLegView(leg, fill, fee, contracts) {
  return {
    book: leg.book,
    side: leg.side || null,
    label: leg.label,
    ticker: leg.ticker || null,
    marketId: leg.marketId || null,
    outcomeId: leg.outcomeId || null,
    isLive: leg.isLive === true,
    quotedPrice: round(leg.price, 4),
    avgPrice: round(fill.vwap, 4),
    american: formatAmerican(fill.vwap),
    contracts,
    stake: round(fill.cost, 2),
    fee: round(fee, 4),
    slippage: round(fill.vwap - leg.price, 4),
  };
}

/**
 * The lock size that makes the most money, and what it makes.
 *
 * Profit is piecewise linear in size — the marginal cost only changes when a price
 * level is exhausted — so the maximum sits on one of those breakpoints (or at the
 * depth cap). Evaluating them all is exact and cheap; ladders have tens of levels.
 *
 * Bisection would be wrong here: Kalshi rounds its fee up to the cent, which is a
 * fixed overhead that makes tiny sizes look unprofitable even when large ones pay.
 */
export function optimalSize({ legA, legB, ladderA, ladderB }) {
  const cap = Math.floor(Math.min(ladderDepth(ladderA), ladderDepth(ladderB)));
  if (cap < 1) return { size: 0, profit: 0 };

  const breakpoints = new Set([cap]);
  for (const ladder of [ladderA, ladderB]) {
    let cumulative = 0;
    for (const level of ladder) {
      cumulative += level.size;
      const n = Math.floor(cumulative);
      if (n >= 1 && n <= cap) breakpoints.add(n);
    }
  }

  const profitAt = (n) => {
    const a = fillCost(ladderA, n);
    const b = fillCost(ladderB, n);
    if (a.filled < n - 1e-6 || b.filled < n - 1e-6) return -Infinity;
    const fees = legFee(legA, n, a.vwap) + legFee(legB, n, b.vwap);
    return n - a.cost - b.cost - fees;
  };

  let best = { size: 0, profit: 0 };
  for (const n of breakpoints) {
    const profit = profitAt(n);
    if (profit > best.profit) best = { size: n, profit: round(profit, 2) };
  }
  return best;
}

/** Prices at the extremes are usually stale or untradeable; skip them. */
export function isSanePrice(p) {
  return p !== null && p >= config.minPrice && p <= config.maxPrice;
}
