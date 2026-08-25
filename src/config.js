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
    // In-flight series fetches. Basic tier refills 200 read tokens/second, so this is
    // well inside budget; it was lowered once after a burst 429 and 6 holds comfortably.
    seriesConcurrency: Number(process.env.KALSHI_CONCURRENCY || 6),
    // Cycles to rest a series that returned nothing before looking again.
    dormantCycles: Number(process.env.KALSHI_DORMANT_CYCLES || 20),
  },

  novig: {
    graphql: 'https://gql.novig.us/v1/graphql',
    // Novig straight-contract taker fee: coefficient * P * (1-P) * contracts,
    // charged only while the event is live (status OPEN_INGAME).
    // Source: https://docs.novig.com/fees
    feeCoefficient: Number(process.env.NOVIG_FEE_COEFFICIENT || 0.03),
    // Hasura enforces a 4s statement timeout, so every query is sharded.
    eventsPerMarketQuery: 20,
    // Market rows per page. Prop-heavy fixtures run a few hundred markets apiece, so
    // results are paged rather than capped — a capped query drops the tail silently.
    marketPageSize: 2000,
    maxMarketPages: 12,
    outcomesPerDepthQuery: 60,
    maxConcurrency: 4,
  },
};

// Novig reports a league string on each event; Kalshi groups the equivalent markets
// into series tickers. `drawPossible` flags competitions where a moneyline is
// three-way, which changes how YES/NO map onto sides.
//
// `props` pairs a Novig player-prop market type with the Kalshi series carrying the
// same stat. Both books quote these as over/under on a `.5` line — Kalshi phrases it
// as "N+" but reports floor_strike as N-0.5 — so strikes compare directly.
// Only pair stats that mean exactly the same thing: Novig separates pitcher and batter
// strikeouts, for instance, while Kalshi's KXMLBKS is pitchers only, so batter
// strikeouts stay unmapped rather than risk a wrong pairing.

const MLB_PROPS = [
  { stat: 'HITS',       novig: 'HITS',               series: 'KXMLBHIT',  label: 'Hits' },
  { stat: 'HR',         novig: 'HOME_RUNS',          series: 'KXMLBHR',   label: 'Home runs' },
  { stat: 'HRR',        novig: 'HITS_RUNS_RBIS',     series: 'KXMLBHRR',  label: 'Hits+runs+RBIs' },
  { stat: 'RBI',        novig: 'RBIS',               series: 'KXMLBRBI',  label: 'RBIs' },
  { stat: 'TB',         novig: 'TOTAL_BASES',        series: 'KXMLBTB',   label: 'Total bases' },
  { stat: 'SB',         novig: 'STOLEN_BASES',       series: 'KXMLBSB',   label: 'Stolen bases' },
  { stat: 'K',          novig: 'PITCHER_STRIKEOUTS', series: 'KXMLBKS',   label: 'Strikeouts' },
  { stat: 'OUTS',       novig: 'PITCHER_OUTS',       series: 'KXMLBOUTS', label: 'Outs recorded' },
  { stat: 'HA',         novig: 'HITS_ALLOWED',       series: 'KXMLBHA',   label: 'Hits allowed' },
  { stat: 'ER',         novig: 'EARNED_RUNS',        series: 'KXMLBERA',  label: 'Earned runs' },
  { stat: 'BBA',        novig: 'WALKS',              series: 'KXMLBWA',   label: 'Walks allowed' },
];

const NFL_PROPS = [
  { stat: 'PASSYDS', novig: 'PASSING_YARDS',      series: 'KXNFLPASSYDS', label: 'Passing yards' },
  { stat: 'RSHYDS',  novig: 'RUSHING_YARDS',      series: 'KXNFLRSHYDS',  label: 'Rushing yards' },
  { stat: 'RECYDS',  novig: 'RECEIVING_YARDS',    series: 'KXNFLRECYDS',  label: 'Receiving yards' },
  { stat: 'REC',     novig: 'RECEPTIONS',         series: 'KXNFLREC',     label: 'Receptions' },
  { stat: 'PASSTD',  novig: 'PASSING_TOUCHDOWNS', series: 'KXNFLPASSTDS', label: 'Passing TDs' },
];

const basketballProps = (prefix) => [
  { stat: 'PTS', novig: 'POINTS',                  series: `${prefix}PTS`, label: 'Points' },
  { stat: 'REB', novig: 'REBOUNDS',                series: `${prefix}REB`, label: 'Rebounds' },
  { stat: 'AST', novig: 'ASSISTS',                 series: `${prefix}AST`, label: 'Assists' },
  { stat: '3PT', novig: 'THREE_POINTERS_MADE',     series: `${prefix}3PT`, label: 'Threes' },
];

const NBA_PROPS = [
  ...basketballProps('KXNBA'),
  { stat: 'PRA', novig: 'POINTS_REBOUNDS_ASSISTS', series: 'KXNBAPRA', label: 'Pts+reb+ast' },
];

const NHL_PROPS = [
  { stat: 'PTS',   novig: 'POINTS',  series: 'KXNHLPTS',   label: 'Points' },
  { stat: 'AST',   novig: 'ASSISTS', series: 'KXNHLAST',   label: 'Assists' },
  { stat: 'SAVES', novig: 'SAVES',   series: 'KXNHLSAVES', label: 'Saves' },
];

export const LEAGUES = [
  { novig: 'MLB',               key: 'MLB',        label: 'MLB',            game: 'KXMLBGAME',         spread: 'KXMLBSPREAD',         total: 'KXMLBTOTAL',         teamTotal: 'KXMLBTEAMTOTAL',   props: MLB_PROPS,              drawPossible: false },
  { novig: 'NFL',               key: 'NFL',        label: 'NFL',            game: 'KXNFLGAME',         spread: 'KXNFLSPREAD',         total: 'KXNFLTOTAL',         teamTotal: 'KXNFLTEAMTOTAL',   props: NFL_PROPS,              drawPossible: false },
  { novig: 'NBA',               key: 'NBA',        label: 'NBA',            game: 'KXNBAGAME',         spread: 'KXNBASPREAD',         total: 'KXNBATOTAL',         teamTotal: 'KXNBATEAMTOTAL',   props: NBA_PROPS,              drawPossible: false },
  { novig: 'NHL',               key: 'NHL',        label: 'NHL',            game: 'KXNHLGAME',         spread: 'KXNHLSPREAD',         total: 'KXNHLTOTAL',         teamTotal: null,               props: NHL_PROPS,              drawPossible: false },
  { novig: 'WNBA',              key: 'WNBA',       label: 'WNBA',           game: 'KXWNBAGAME',        spread: 'KXWNBASPREAD',        total: 'KXWNBATOTAL',        teamTotal: 'KXWNBATEAMTOTAL',  props: basketballProps('KXWNBA'), drawPossible: false },
  { novig: 'NCAAF',             key: 'NCAAF',      label: 'NCAAF',          game: 'KXNCAAFGAME',       spread: 'KXNCAAFSPREAD',       total: 'KXNCAAFTOTAL',       teamTotal: 'KXNCAAFTEAMTOTAL', props: [],                     drawPossible: false },
  { novig: 'NCAAB',             key: 'NCAAB',      label: 'NCAAB',          game: 'KXNCAAMBGAME',      spread: 'KXNCAAMBSPREAD',      total: 'KXNCAAMBTOTAL',      teamTotal: null,               props: [],                     drawPossible: false },
  { novig: 'CFL',               key: 'CFL',        label: 'CFL',            game: 'KXCFLGAME',         spread: 'KXCFLSPREAD',         total: 'KXCFLTOTAL',         teamTotal: null,               props: [],                     drawPossible: false },
  { novig: 'EPL',               key: 'EPL',        label: 'Premier League', game: 'KXEPLGAME',         spread: 'KXEPLSPREAD',         total: 'KXEPLTOTAL',         teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'La Liga',           key: 'LALIGA',     label: 'La Liga',        game: 'KXLALIGAGAME',      spread: 'KXLALIGASPREAD',      total: 'KXLALIGATOTAL',      teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'Serie A',           key: 'SERIEA',     label: 'Serie A',        game: 'KXSERIEAGAME',      spread: 'KXSERIEASPREAD',      total: 'KXSERIEATOTAL',      teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'Ligue 1',           key: 'LIGUE1',     label: 'Ligue 1',        game: 'KXLIGUE1GAME',      spread: 'KXLIGUE1SPREAD',      total: 'KXLIGUE1TOTAL',      teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'Bundesliga',        key: 'BUNDESLIGA', label: 'Bundesliga',     game: 'KXBUNDESLIGAGAME',  spread: 'KXBUNDESLIGASPREAD',  total: 'KXBUNDESLIGATOTAL',  teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'MLS',               key: 'MLS',        label: 'MLS',            game: 'KXMLSGAME',         spread: 'KXMLSSPREAD',         total: 'KXMLSTOTAL',         teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'Champions League',  key: 'UCL',        label: 'Champions Lg',   game: 'KXUCLGAME',         spread: 'KXUCLSPREAD',         total: 'KXUCLTOTAL',         teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'Europa League',     key: 'UEL',        label: 'Europa Lg',      game: 'KXUELGAME',         spread: 'KXUELSPREAD',         total: 'KXUELTOTAL',         teamTotal: null,               props: [],                     drawPossible: true },
  { novig: 'ATP',               key: 'ATP',        label: 'ATP Tennis',     game: 'KXATPMATCH',        spread: null,                  total: null,                 teamTotal: null,               props: [],                     drawPossible: false },
  { novig: 'WTA',               key: 'WTA',        label: 'WTA Tennis',     game: 'KXWTAMATCH',        spread: null,                  total: null,                 teamTotal: null,               props: [],                     drawPossible: false },
];

/** Every Novig market type this scanner knows how to pair, for the market query filter. */
export const NOVIG_MARKET_TYPES = [
  ...new Set([
    'MONEY', 'SPREAD', 'TOTAL', 'TEAM_TOTAL', 'MONEYLINE_3_WAY_WIN', 'MONEYLINE_3_WAY_DRAW',
    ...LEAGUES.flatMap((l) => l.props.map((p) => p.novig)),
  ]),
];
