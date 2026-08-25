// Kalshi adapter. All market-data endpoints used here are public — no API key required.
// Docs: https://docs.kalshi.com/getting_started/quick_start_market_data

import { config } from './config.js';
import { fetchJson, num, chunk, mapLimit, warn } from './util.js';
import { playerFromSubtitle } from './teams.js';

const BASE = config.kalshi.rest;

/** Series metadata (fee_type, fee_multiplier) is static enough to cache for the process. */
const seriesCache = new Map();

export async function loadSeries(tickers) {
  const missing = [...new Set(tickers.filter((t) => t && !seriesCache.has(t)))];
  await mapLimit(missing, 4, async (ticker) => {
    try {
      const data = await fetchJson(`${BASE}/series/${encodeURIComponent(ticker)}`);
      const s = data.series || data;
      seriesCache.set(ticker, {
        ticker,
        feeType: s.fee_type || 'quadratic',
        feeMultiplier: num(s.fee_multiplier) ?? 1,
      });
    } catch (err) {
      warn(`kalshi: could not load series ${ticker} (${err.message}); assuming 1x quadratic fees`);
      seriesCache.set(ticker, { ticker, feeType: 'quadratic', feeMultiplier: 1 });
    }
  });
  return seriesCache;
}

export function seriesFeeMultiplier(ticker) {
  return seriesCache.get(ticker)?.feeMultiplier ?? 1;
}

/**
 * Kalshi encodes the fixture into the event ticker: KXMLBGAME-26AUG241845COLWSH
 * is 2026-08-24, 18:45 Eastern, COL at WSH. The HHMM block is optional (soccer omits it).
 */
export function parseEventTicker(eventTicker) {
  const dash = eventTicker.indexOf('-');
  if (dash < 0) return null;
  const rest = eventTicker.slice(dash + 1);
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{4})?/.exec(rest);
  if (!m) return null;

  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = months[m[2]];
  if (month === undefined) return null;

  return {
    seriesTicker: eventTicker.slice(0, dash),
    year: 2000 + Number(m[1]),
    month,
    day: Number(m[3]),
    // Local (Eastern) calendar date as Kalshi labels it; used only for coarse matching.
    dateKey: `${2000 + Number(m[1])}-${String(month + 1).padStart(2, '0')}-${m[3]}`,
    hhmm: m[4] || null,
  };
}

/** "COL vs WSH (Aug 24)" -> ['COL','WSH'];  "Colorado vs Washington" -> ['Colorado','Washington']. */
function splitVersus(text) {
  if (!text) return [null, null];
  const cleaned = String(text).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const parts = cleaned.split(/\s+(?:vs\.?|@|at)\s+/i);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : [null, null];
}

async function fetchEventPages(seriesTicker) {
  const events = [];
  let cursor = null;

  for (let page = 0; page < 8; page++) {
    const params = new URLSearchParams({
      series_ticker: seriesTicker,
      status: 'open',
      with_nested_markets: 'true',
      limit: String(config.kalshi.eventPageLimit),
    });
    if (cursor) params.set('cursor', cursor);

    // The first cycle warms the series cache and fetches every fixture at once, which
    // can brush the rate limit; an extra retry rides out that burst.
    const data = await fetchJson(`${BASE}/events?${params}`, { retries: 3 });
    events.push(...(data.events || []));
    cursor = data.cursor;
    if (!cursor || !(data.events || []).length) break;
  }
  return events;
}

/**
 * Normalize one Kalshi series into fixtures keyed by event ticker.
 * `kind` is 'game' | 'spread' | 'total' | 'teamTotal' | 'prop' and decides how markets
 * are interpreted later. `stat` names the prop when kind is 'prop'.
 */
export async function fetchSeriesFixtures(seriesTicker, kind, stat = null) {
  const raw = await fetchEventPages(seriesTicker);
  const fixtures = [];

  for (const ev of raw) {
    const parsed = parseEventTicker(ev.event_ticker);
    if (!parsed) continue;

    const [awayAbbr, homeAbbr] = splitVersus(ev.sub_title);
    let [awayName, homeName] = splitVersus(ev.title);
    // Total/spread events title themselves "Boston vs Miami: Total Runs".
    if (homeName) homeName = homeName.replace(/:.*$/, '').trim();

    const markets = (ev.markets || [])
      .filter((m) => m.status === 'active')
      .map((m) => ({
        ticker: m.ticker,
        suffix: m.ticker.startsWith(`${ev.event_ticker}-`) ? m.ticker.slice(ev.event_ticker.length + 1) : null,
        title: m.title,
        yesSubTitle: m.yes_sub_title,
        // Prop subtitles read "Adley Rutschman: 1+"; the name is the identity we match on.
        playerName: kind === 'prop' ? playerFromSubtitle(m.yes_sub_title) : null,
        floorStrike: num(m.floor_strike),
        capStrike: num(m.cap_strike),
        strikeType: m.strike_type,
        yesAsk: num(m.yes_ask_dollars),
        noAsk: num(m.no_ask_dollars),
        yesBid: num(m.yes_bid_dollars),
        noBid: num(m.no_bid_dollars),
        // yes_ask_size is depth at the YES ask; the NO ask sits on the YES bid queue.
        yesAskSize: num(m.yes_ask_size_fp),
        noAskSize: num(m.yes_bid_size_fp),
        volume: num(m.volume_fp) ?? 0,
        closeTime: m.close_time,
      }));

    if (!markets.length) continue;

    fixtures.push({
      book: 'kalshi',
      kind,
      stat,
      seriesTicker,
      eventTicker: ev.event_ticker,
      title: ev.title,
      subTitle: ev.sub_title,
      dateKey: parsed.dateKey,
      hhmm: parsed.hhmm,
      mutuallyExclusive: ev.mutually_exclusive === true,
      away: { name: awayName, abbr: awayAbbr },
      home: { name: homeName, abbr: homeAbbr },
      markets,
    });
  }

  return fixtures;
}

/** Full order books for up to 100 tickers per call. Returns Map<ticker, {yes,no}> of bid ladders. */
export async function fetchOrderbooks(tickers) {
  const out = new Map();
  const unique = [...new Set(tickers.filter(Boolean))];

  for (const group of chunk(unique, config.kalshi.maxTickersPerOrderbookCall)) {
    const params = new URLSearchParams();
    for (const t of group) params.append('tickers', t);
    try {
      const data = await fetchJson(`${BASE}/markets/orderbooks?${params}`);
      for (const ob of data.orderbooks || []) {
        const book = ob.orderbook_fp || {};
        out.set(ob.ticker, {
          yesBids: (book.yes_dollars || []).map(([p, q]) => [num(p), num(q)]),
          noBids: (book.no_dollars || []).map(([p, q]) => [num(p), num(q)]),
        });
      }
    } catch (err) {
      warn(`kalshi: orderbook batch failed (${err.message})`);
    }
  }
  return out;
}

/**
 * Ask ladder for one side, cheapest first.
 * A NO bid at q is a YES ask at 1-q for the same size, and vice versa.
 */
export function askLadder(orderbook, side) {
  if (!orderbook) return [];
  const bids = side === 'yes' ? orderbook.noBids : orderbook.yesBids;
  return bids
    .filter(([p, q]) => p !== null && q !== null && q > 0)
    .map(([p, q]) => ({ price: 1 - p, size: q }))
    .sort((a, b) => a.price - b.price);
}

/** Kalshi trading fee: ceil(coefficient * multiplier * contracts * P * (1-P)) to the cent. */
export function kalshiFee(contracts, price, feeMultiplier = 1) {
  const raw = config.kalshi.feeCoefficient * feeMultiplier * contracts * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}
