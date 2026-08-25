// Scan orchestration.
//
// One cycle:
//   1. Ask Novig which leagues actually have open fixtures right now.
//   2. Pull those leagues' Kalshi series (events with nested markets -> top of book).
//   3. Match fixtures across the books and build canonical contracts.
//   4. Screen every contract on top-of-book asks.
//   5. For contracts that screen close to (or above) break-even, pull real order books
//      from both venues and re-price by walking the ladders.

import { EventEmitter } from 'node:events';
import { config, LEAGUES } from './config.js';
import * as kalshi from './kalshi.js';
import * as novig from './novig.js';
import { groupKalshiFixtures, matchFixtures, buildContracts, COMPLEMENT } from './match.js';
import { priceArb, optimalSize, isSanePrice, ladderDepth } from './arb.js';
import { mapLimit, log, warn, round, formatAmerican } from './util.js';

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.settings = {
      targetStake: config.targetStake,
      anchor: 'larger',
    };
    this.snapshot = {
      updatedAt: null,
      cycleMs: null,
      opportunities: [],
      board: [],
      stats: emptyStats(),
      errors: [],
      settings: this.settings,
    };
    this.timer = null;
    this.running = false;
    // Series that came back empty (out of season, or props not posted yet) are rechecked
    // occasionally rather than every cycle. Value is cycles left to skip.
    this.dormantSeries = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Self-pacing: wait `pollMs` after a cycle finishes rather than firing on a fixed
    // interval, so a slow scan can never stack cycles on top of each other.
    const loop = async () => {
      while (this.running) {
        try {
          await this.cycle();
        } catch (err) {
          warn('cycle failed:', err.message);
          this.snapshot.errors = [String(err.message)];
          this.emit('update', this.snapshot);
        }
        if (!this.running) break;
        await new Promise((resolve) => {
          this.timer = setTimeout(resolve, config.pollMs);
        });
      }
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  updateSettings(patch) {
    if (patch.targetStake !== undefined) {
      const v = Number(patch.targetStake);
      if (Number.isFinite(v) && v > 0) this.settings.targetStake = v;
    }
    if (patch.anchor && ['larger', 'kalshi', 'novig'].includes(patch.anchor)) {
      this.settings.anchor = patch.anchor;
    }
    this.snapshot.settings = { ...this.settings };
  }

  async cycle() {
    const started = Date.now();
    const errors = [];
    const stats = emptyStats();

    // --- 1. Novig fixtures, which also tells us which leagues are in season ---------
    const novigEvents = await novig.fetchOpenEvents(LEAGUES.map((l) => l.novig));
    stats.novigEvents = novigEvents.length;

    const eventsByLeague = new Map();
    for (const ev of novigEvents) {
      if (!eventsByLeague.has(ev.league)) eventsByLeague.set(ev.league, []);
      eventsByLeague.get(ev.league).push(ev);
    }

    const activeLeagues = LEAGUES.filter((l) => (eventsByLeague.get(l.novig) || []).length > 0);
    stats.activeLeagues = activeLeagues.length;

    // --- 2. Kalshi fixtures for those leagues --------------------------------------
    const seriesJobs = [];
    for (const league of activeLeagues) {
      for (const kind of ['game', 'spread', 'total', 'teamTotal']) {
        if (league[kind]) seriesJobs.push({ league, kind, seriesTicker: league[kind] });
      }
      for (const prop of league.props || []) {
        seriesJobs.push({ league, kind: 'prop', stat: prop.stat, seriesTicker: prop.series });
      }
    }

    await kalshi.loadSeries(seriesJobs.map((j) => j.seriesTicker));

    const dueJobs = seriesJobs.filter((job) => {
      const remaining = this.dormantSeries.get(job.seriesTicker) || 0;
      if (remaining <= 0) return true;
      this.dormantSeries.set(job.seriesTicker, remaining - 1);
      return false;
    });
    stats.seriesQueried = dueJobs.length;
    stats.seriesDormant = seriesJobs.length - dueJobs.length;

    const fetched = await mapLimit(dueJobs, config.kalshi.seriesConcurrency, async (job) => {
      try {
        const fixtures = await kalshi.fetchSeriesFixtures(job.seriesTicker, job.kind, job.stat);
        if (fixtures.length) this.dormantSeries.delete(job.seriesTicker);
        else this.dormantSeries.set(job.seriesTicker, config.kalshi.dormantCycles);
        return { job, fixtures };
      } catch (err) {
        errors.push(`kalshi ${job.seriesTicker}: ${err.message}`);
        return { job, fixtures: [] };
      }
    });

    const kalshiByLeague = new Map();
    for (const { job, fixtures } of fetched) {
      if (!kalshiByLeague.has(job.league.key)) kalshiByLeague.set(job.league.key, []);
      kalshiByLeague.get(job.league.key).push(...fixtures);
      stats.kalshiFixtures += fixtures.length;
    }

    // --- 3. Match fixtures ----------------------------------------------------------
    const pairs = [];
    for (const league of activeLeagues) {
      const groups = groupKalshiFixtures(kalshiByLeague.get(league.key) || []);
      const events = eventsByLeague.get(league.novig) || [];
      for (const pair of matchFixtures(groups, events)) {
        pairs.push({ ...pair, league });
      }
    }
    stats.matchedFixtures = pairs.length;

    if (!pairs.length) {
      this.publish({ opportunities: [], board: [], stats, errors, started });
      return;
    }

    // --- 4. Novig market prices for the matched fixtures only -----------------------
    let novigMarkets = [];
    try {
      novigMarkets = await novig.fetchMarkets(pairs.map((p) => p.novig.id));
    } catch (err) {
      errors.push(`novig markets: ${err.message}`);
    }

    const marketsByEvent = new Map();
    for (const m of novigMarkets) {
      if (!marketsByEvent.has(m.eventId)) marketsByEvent.set(m.eventId, []);
      marketsByEvent.get(m.eventId).push(m);
    }
    stats.novigMarkets = novigMarkets.length;

    // --- 5. Screen on top of book ---------------------------------------------------
    const board = [];
    const candidates = [];
    // Each trade is discovered twice (once from each side of the contract, with the
    // legs swapped). Key on the unordered pair of leg identities and keep one.
    const seenTrades = new Set();

    for (const pair of pairs) {
      const contracts = buildContracts(pair, marketsByEvent, pair.league);

      for (const contract of contracts.values()) {
        for (const [side, legs] of Object.entries(contract.sides)) {
          const otherSide = COMPLEMENT[side];
          const otherLegs = contract.sides[otherSide];
          if (!otherLegs) continue;

          // Only cross-book pairings: this side on Kalshi, the complement on Novig,
          // and the mirror image. Same-book pairs are just the venue's own spread.
          for (const [aLegs, bLegs] of [
            [legs.kalshi, otherLegs.novig],
            [legs.novig, otherLegs.kalshi],
          ]) {
            const legA = bestLeg(aLegs);
            const legB = bestLeg(bLegs);
            if (!legA || !legB) continue;
            if (!isSanePrice(legA.price) || !isSanePrice(legB.price)) continue;

            stats.pairsScreened++;
            const topEdge = 1 - (legA.price + legB.price);

            const row = {
              pair,
              contract,
              side,
              otherSide,
              legA,
              legB,
              topEdge,
            };
            board.push(row);

            const tradeKey = [legIdentity(legA), legIdentity(legB)].sort().join('~');
            if (topEdge > config.nearMissEdge && !seenTrades.has(tradeKey)) {
              seenTrades.add(tradeKey);
              candidates.push(row);
            }
          }
        }
      }
    }

    stats.boardRows = board.length;
    stats.candidates = candidates.length;

    // --- 6. Real depth for the candidates -------------------------------------------
    const kalshiTickers = [];
    const novigSiblings = [];
    for (const c of candidates) {
      for (const leg of [c.legA, c.legB]) {
        if (leg.book === 'kalshi') kalshiTickers.push(leg.ticker);
        else novigSiblings.push(leg.siblingOutcomeId);
      }
    }

    const [orderbooks, bidLadders] = await Promise.all([
      kalshiTickers.length ? kalshi.fetchOrderbooks(kalshiTickers) : Promise.resolve(new Map()),
      novigSiblings.length ? novig.fetchBidLadders(novigSiblings) : Promise.resolve(new Map()),
    ]);

    const ladderFor = (leg) => {
      if (leg.book === 'kalshi') {
        const ladder = kalshi.askLadder(orderbooks.get(leg.ticker), leg.side);
        // Fall back to the quoted top of book if the order book came back empty.
        if (ladder.length) return ladder;
        return leg.topSize > 0 ? [{ price: leg.price, size: leg.topSize }] : [];
      }
      return novig.askLadderFromSiblingBids(bidLadders.get(leg.siblingOutcomeId));
    };

    // --- 7. Price each candidate by walking the books --------------------------------
    const opportunities = [];
    for (const c of candidates) {
      const ladderA = ladderFor(c.legA);
      const ladderB = ladderFor(c.legB);
      if (!ladderA.length || !ladderB.length) continue;

      const priced = priceArb({
        legA: c.legA,
        legB: c.legB,
        ladderA,
        ladderB,
        targetStake: this.settings.targetStake,
        anchor: this.settings.anchor,
      });
      if (!priced) continue;

      const best = optimalSize({ legA: c.legA, legB: c.legB, ladderA, ladderB });

      opportunities.push({
        id: opportunityId(c),
        league: c.pair.league.label,
        leagueKey: c.pair.league.key,
        fixture: fixtureLabel(c.pair),
        startsAt: c.pair.novig.start,
        isLive: c.pair.novig.isLive,
        marketType: c.contract.meta.type,
        marketLabel: contractLabel(c.contract, c.side, c.pair),
        side: c.side,
        otherSide: c.otherSide,
        matchScore: round(c.pair.score, 3),
        kalshiEvent: c.pair.kalshi.key,
        novigEventId: c.pair.novig.id,
        ...priced,
        bestSize: best.size,
        bestProfit: best.profit,
        depthA: round(ladderDepth(ladderA), 2),
        depthB: round(ladderDepth(ladderB), 2),
      });
    }

    opportunities.sort((a, b) => b.netRoi - a.netRoi);
    stats.opportunities = opportunities.filter((o) => o.profit > 0).length;

    this.publish({
      opportunities,
      board: buildBoardView(board),
      stats,
      errors,
      started,
    });
  }

  publish({ opportunities, board, stats, errors, started }) {
    this.snapshot = {
      updatedAt: new Date().toISOString(),
      cycleMs: Date.now() - started,
      opportunities,
      board,
      stats,
      errors,
      settings: { ...this.settings },
    };
    this.emit('update', this.snapshot);
  }
}

function emptyStats() {
  return {
    activeLeagues: 0,
    novigEvents: 0,
    kalshiFixtures: 0,
    matchedFixtures: 0,
    novigMarkets: 0,
    seriesQueried: 0,
    seriesDormant: 0,
    pairsScreened: 0,
    boardRows: 0,
    candidates: 0,
    opportunities: 0,
  };
}

/** Stable identity for one leg, so mirrored discoveries of the same trade collapse. */
function legIdentity(leg) {
  return leg.book === 'kalshi' ? `k:${leg.ticker}:${leg.side}` : `n:${leg.outcomeId}`;
}

/** Cheapest quoted ask among the legs offering a side on one book. */
function bestLeg(legs) {
  if (!legs?.length) return null;
  return legs.reduce((best, leg) => (best === null || leg.price < best.price ? leg : best), null);
}

function fixtureLabel(pair) {
  const { away, home } = pair.novig;
  return `${away.name} @ ${home.name}`;
}

function contractLabel(contract, side, pair) {
  const { meta } = contract;
  const { away, home } = pair.novig;

  if (meta.type === 'moneyline') {
    return `Moneyline — ${side === 'HOME' ? home.name : away.name}`;
  }
  if (meta.type === 'moneyline3') {
    const who = contract.key.endsWith('HOME') ? home.name : contract.key.endsWith('AWAY') ? away.name : 'Draw';
    return `3-Way — ${who} ${side}`;
  }
  if (meta.type === 'total') {
    return `Total ${meta.strike} — ${side}`;
  }
  if (meta.type === 'spread') {
    const line = meta.strike;
    const shown = side === 'HOME' ? line : -line;
    const team = side === 'HOME' ? home.name : away.name;
    return `Spread — ${team} ${shown > 0 ? '+' : ''}${shown}`;
  }
  if (meta.type === 'teamTotal') {
    const team = meta.subject === 'home' ? home.name : away.name;
    return `${team} team total ${meta.strike} — ${side}`;
  }
  if (meta.type === 'prop') {
    return `${meta.player} — ${meta.statLabel} ${side === 'OVER' ? 'over' : 'under'} ${meta.strike}`;
  }
  return contract.key;
}

function opportunityId(c) {
  return `${c.pair.novig.id}|${c.contract.key}|${c.side}|${c.legA.book}`;
}

/**
 * Flatten the screening pass into a two-column odds board: for each contract side,
 * what each book is asking. This is the live odds feed the UI renders.
 */
function buildBoardView(rows) {
  const byKey = new Map();

  for (const r of rows) {
    const key = `${r.pair.novig.id}|${r.contract.key}|${r.side}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: key,
        league: r.pair.league.label,
        leagueKey: r.pair.league.key,
        fixture: fixtureLabel(r.pair),
        startsAt: r.pair.novig.start,
        isLive: r.pair.novig.isLive,
        marketType: r.contract.meta.type,
        marketLabel: contractLabel(r.contract, r.side, r.pair),
        kalshi: null,
        novig: null,
        bestEdge: -Infinity,
      });
    }
    const entry = byKey.get(key);

    for (const leg of [r.legA, r.legB]) {
      // legB quotes the complementary side, so it belongs on the other row.
      if (leg === r.legB) continue;
      const view = {
        price: round(leg.price, 4),
        american: formatAmerican(leg.price),
        label: leg.label,
        ticker: leg.ticker || null,
        outcomeId: leg.outcomeId || null,
      };
      if (leg.book === 'kalshi') entry.kalshi = view;
      else entry.novig = view;
    }

    entry.bestEdge = Math.max(entry.bestEdge, r.topEdge);
  }

  return [...byKey.values()]
    .filter((e) => e.kalshi && e.novig)
    .map((e) => ({ ...e, bestEdge: e.bestEdge === -Infinity ? null : round(e.bestEdge, 4) }));
}
