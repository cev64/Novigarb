// Central configuration: tunables, fee schedules, and the Novig-league -> Kalshi-series map.

export const config = {
  port: Number(process.env.PORT || 8787),

  // Poll cadence for a full scan cycle, in milliseconds.
  pollMs: Number(process.env.POLL_MS || 8000),

  // Stake used to size the anchor leg of every opportunity, in dollars.
  targetStake: Number(process.env.TARGET_STAKE || 100),

  // Pairs screening above this gross edge get priced against real order books, so the
  // board shows near-misses as well as live arbitrage.
  nearMissEdge: Number(process.env.NEAR_MISS_EDGE || -0.02),

  // Ignore quotes at the extremes: they are usually stale or untradeable.
  minPrice: 0.02,
  maxPrice: 0.98,

  kalshi: {
    rest: 'https://external-api.kalshi.com/trade-api/v2',
    // Kalshi's General Trading Fees Table: fee = ceil(coefficient * contracts * P * (1-P)),
    // rounded up to the cent, scaled by the series' own fee_multiplier.
    // Source: https://kalshi.com/docs/kalshi-fee-schedule.pdf
    feeCoefficient: Number(process.env.KALSHI_FEE_COEFFICIENT || 0.07),
    maxTickersPerOrderbookCall: 100,
    eventPageLimit: 200,
  },

  novig: {
    graphql: 'https://gql.novig.us/v1/graphql',
    // Novig straight-contract taker fee: coefficient * P * (1-P) * contracts,
    // charged only while the event is live (status OPEN_INGAME).
    // Source: https://docs.novig.com/fees
    feeCoefficient: Number(process.env.NOVIG_FEE_COEFFICIENT || 0.03),
    // Hasura enforces a 4s statement timeout, so every query is sharded.
    eventsPerMarketQuery: 20,
    outcomesPerDepthQuery: 60,
    maxConcurrency: 4,
  },
};

// Novig reports a league string on each event; Kalshi groups the equivalent markets
// into series tickers. `drawPossible` flags competitions where a moneyline is
// three-way, which changes how YES/NO map onto sides.
export const LEAGUES = [
  { novig: 'MLB',               key: 'MLB',        label: 'MLB',            game: 'KXMLBGAME',         spread: 'KXMLBSPREAD',         total: 'KXMLBTOTAL',         drawPossible: false },
  { novig: 'NFL',               key: 'NFL',        label: 'NFL',            game: 'KXNFLGAME',         spread: 'KXNFLSPREAD',         total: 'KXNFLTOTAL',         drawPossible: false },
  { novig: 'NBA',               key: 'NBA',        label: 'NBA',            game: 'KXNBAGAME',         spread: 'KXNBASPREAD',         total: 'KXNBATOTAL',         drawPossible: false },
  { novig: 'NHL',               key: 'NHL',        label: 'NHL',            game: 'KXNHLGAME',         spread: 'KXNHLSPREAD',         total: 'KXNHLTOTAL',         drawPossible: false },
  { novig: 'WNBA',              key: 'WNBA',       label: 'WNBA',           game: 'KXWNBAGAME',        spread: 'KXWNBASPREAD',        total: 'KXWNBATOTAL',        drawPossible: false },
  { novig: 'NCAAF',             key: 'NCAAF',      label: 'NCAAF',          game: 'KXNCAAFGAME',       spread: 'KXNCAAFSPREAD',       total: 'KXNCAAFTOTAL',       drawPossible: false },
  { novig: 'NCAAB',             key: 'NCAAB',      label: 'NCAAB',          game: 'KXNCAAMBGAME',      spread: 'KXNCAAMBSPREAD',      total: 'KXNCAAMBTOTAL',      drawPossible: false },
  { novig: 'CFL',               key: 'CFL',        label: 'CFL',            game: 'KXCFLGAME',         spread: 'KXCFLSPREAD',         total: 'KXCFLTOTAL',         drawPossible: false },
  { novig: 'EPL',               key: 'EPL',        label: 'Premier League', game: 'KXEPLGAME',         spread: 'KXEPLSPREAD',         total: 'KXEPLTOTAL',         drawPossible: true },
  { novig: 'La Liga',           key: 'LALIGA',     label: 'La Liga',        game: 'KXLALIGAGAME',      spread: 'KXLALIGASPREAD',      total: 'KXLALIGATOTAL',      drawPossible: true },
  { novig: 'Serie A',           key: 'SERIEA',     label: 'Serie A',        game: 'KXSERIEAGAME',      spread: 'KXSERIEASPREAD',      total: 'KXSERIEATOTAL',      drawPossible: true },
  { novig: 'Ligue 1',           key: 'LIGUE1',     label: 'Ligue 1',        game: 'KXLIGUE1GAME',      spread: 'KXLIGUE1SPREAD',      total: 'KXLIGUE1TOTAL',      drawPossible: true },
  { novig: 'Bundesliga',        key: 'BUNDESLIGA', label: 'Bundesliga',     game: 'KXBUNDESLIGAGAME',  spread: 'KXBUNDESLIGASPREAD',  total: 'KXBUNDESLIGATOTAL',  drawPossible: true },
  { novig: 'MLS',               key: 'MLS',        label: 'MLS',            game: 'KXMLSGAME',         spread: 'KXMLSSPREAD',         total: 'KXMLSTOTAL',         drawPossible: true },
  { novig: 'Champions League',  key: 'UCL',        label: 'Champions Lg',   game: 'KXUCLGAME',         spread: 'KXUCLSPREAD',         total: 'KXUCLTOTAL',         drawPossible: true },
  { novig: 'Europa League',     key: 'UEL',        label: 'Europa Lg',      game: 'KXUELGAME',         spread: 'KXUELSPREAD',         total: 'KXUELTOTAL',         drawPossible: true },
  { novig: 'ATP',               key: 'ATP',        label: 'ATP Tennis',     game: 'KXATPMATCH',        spread: null,                  total: null,                 drawPossible: false },
  { novig: 'WTA',               key: 'WTA',        label: 'WTA Tennis',     game: 'KXWTAMATCH',        spread: null,                  total: null,                 drawPossible: false },
];
