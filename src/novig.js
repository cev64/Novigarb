// Novig adapter, over the public read-only GraphQL API (no auth required).
// Docs: https://docs.novig.com/api-reference/graphql/overview
//
// Two things drive the shape of this module:
//  1. Hasura enforces a 4s statement timeout, so nested `orders` are fetched separately
//     from markets rather than in one deep query.
//  2. Orders are stored as BIDS. A bid of `qty` at price p on outcome A is offered
//     liquidity to BUY the sibling outcome B at (1 - p). `qty` is in cents of payout,
//     so 100 qty = 1 contract.

import { config } from './config.js';
import { fetchJson, num, chunk, mapLimit, warn } from './util.js';

const ENDPOINT = config.novig.graphql;
const OPEN_STATUSES = ['OPEN_PREGAME', 'OPEN_INGAME'];

async function gql(query, variables) {
  const data = await fetchJson(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (data.errors?.length) throw new Error(`novig graphql: ${data.errors[0].message}`);
  return data.data;
}

const EVENTS_QUERY = `
query OpenEvents($leagues: [String!], $statuses: [String!]) {
  event(where: {league: {_in: $leagues}, status: {_in: $statuses}}, limit: 1000) {
    id
    description
    league
    status
    scheduled_start
    game {
      id
      scheduled_start
      homeTeam { id name symbol }
      awayTeam { id name symbol }
    }
  }
}`;

/** Open events for the given Novig league names, restricted to real fixtures (game != null). */
export async function fetchOpenEvents(leagueNames) {
  const data = await gql(EVENTS_QUERY, { leagues: leagueNames, statuses: OPEN_STATUSES });

  return (data.event || [])
    .filter((e) => e.game && e.game.homeTeam && e.game.awayTeam)
    .map((e) => ({
      book: 'novig',
      id: e.id,
      league: e.league,
      status: e.status,
      isLive: e.status === 'OPEN_INGAME',
      description: e.description,
      start: e.game.scheduled_start || e.scheduled_start,
      home: { id: e.game.homeTeam.id, name: e.game.homeTeam.name, symbol: e.game.homeTeam.symbol },
      away: { id: e.game.awayTeam.id, name: e.game.awayTeam.name, symbol: e.game.awayTeam.symbol },
    }));
}

const MARKETS_QUERY = `
query EventMarkets($eventIds: [uuid!], $types: [String!]) {
  market(where: {eventId: {_in: $eventIds}, status: {_eq: "OPEN"}, type: {_in: $types}}, limit: 2000) {
    id
    eventId
    description
    type
    strike
    volume
    competitor { id name symbol }
    outcomes {
      id
      index
      type
      description
      available
      last
      status
    }
  }
}`;

const MARKET_TYPES = ['MONEY', 'SPREAD', 'TOTAL', 'MONEYLINE_3_WAY_WIN', 'MONEYLINE_3_WAY_DRAW'];

/**
 * Markets (with per-outcome ask prices) for a set of event ids. `available` is Novig's
 * current offer price for that outcome, i.e. 1 - best bid on its sibling.
 */
export async function fetchMarkets(eventIds) {
  const batches = chunk(eventIds, config.novig.eventsPerMarketQuery);

  const results = await mapLimit(batches, config.novig.maxConcurrency, async (batch) => {
    try {
      const data = await gql(MARKETS_QUERY, { eventIds: batch, types: MARKET_TYPES });
      return data.market || [];
    } catch (err) {
      warn(`novig: market batch failed (${err.message})`);
      return [];
    }
  });

  return results.flat().map((m) => ({
    id: m.id,
    eventId: m.eventId,
    description: m.description,
    type: m.type,
    strike: num(m.strike),
    volume: num(m.volume) ?? 0,
    competitor: m.competitor || null,
    outcomes: (m.outcomes || []).map((o) => ({
      id: o.id,
      index: o.index,
      type: o.type,
      description: o.description,
      available: num(o.available),
      last: num(o.last),
      status: o.status,
    })),
  }));
}

const DEPTH_QUERY = `
query OutcomeDepth($outcomeIds: [uuid!]) {
  order(
    where: {outcome_id: {_in: $outcomeIds}, status: {_eq: "OPEN"}, currency: {_eq: "CASH"}}
    order_by: {price: desc}
    limit: 2000
  ) {
    outcome_id
    price
    qty
  }
}`;

/**
 * Resting bid ladders for the given outcome ids, best price first.
 * Returns Map<outcomeId, [{price, contracts}]>.
 */
export async function fetchBidLadders(outcomeIds) {
  const unique = [...new Set(outcomeIds.filter(Boolean))];
  const batches = chunk(unique, config.novig.outcomesPerDepthQuery);
  const ladders = new Map();

  const results = await mapLimit(batches, config.novig.maxConcurrency, async (batch) => {
    try {
      const data = await gql(DEPTH_QUERY, { outcomeIds: batch });
      return data.order || [];
    } catch (err) {
      warn(`novig: depth batch failed (${err.message})`);
      return [];
    }
  });

  for (const row of results.flat()) {
    const price = num(row.price);
    const qty = num(row.qty);
    if (price === null || qty === null || qty <= 0) continue;
    if (!ladders.has(row.outcome_id)) ladders.set(row.outcome_id, []);
    // qty is cents of payout; 100 qty = one $1 contract.
    ladders.get(row.outcome_id).push({ price, contracts: qty / 100 });
  }

  for (const ladder of ladders.values()) ladder.sort((a, b) => b.price - a.price);
  return ladders;
}

/**
 * Convert a sibling outcome's bid ladder into the ask ladder for the outcome you want
 * to buy: a bid at p becomes an ask at (1 - p) for the same contract count.
 */
export function askLadderFromSiblingBids(siblingBids) {
  if (!siblingBids?.length) return [];
  return siblingBids
    .map((b) => ({ price: 1 - b.price, size: b.contracts }))
    .filter((a) => a.price > 0 && a.price < 1)
    .sort((a, b) => a.price - b.price);
}

/**
 * Novig straight-contract taker fee. Charged only while the event is live
 * (status OPEN_INGAME); pregame fills are free. No cent floor.
 */
export function novigFee(contracts, price, isLive) {
  if (!isLive) return 0;
  return config.novig.feeCoefficient * contracts * price * (1 - price);
}
