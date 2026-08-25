# Novigarb

A live arbitrage scanner for **Kalshi** and **Novig** — an OddsJam-style board, but built for
exactly two venues and for the one thing that matters: locking a guaranteed profit by buying
both sides of the same proposition on different books.

It runs entirely on your machine, needs no API keys, and installs nothing.

<img width="900" alt="Novigarb dashboard" src="docs/screenshot.png">

## Run it

```bash
node server.js
```

Then open **http://localhost:8787**.

Requires Node 18 or newer (`node --version`). There are no dependencies to install — the whole
thing is standard library plus `fetch`.

For a one-shot scan in the terminal instead of the browser:

```bash
npm run scan
```

## What it does

Every few seconds it:

1. Asks **Novig** which fixtures are open right now (that also tells it which leagues are in season).
2. Pulls the matching **Kalshi** series for those leagues — moneyline, spread and total.
3. Matches fixtures across the two books by team identity and date.
4. Compares every proposition both venues quote, in both directions.
5. Walks each venue's real order book to price a two-leg lock, net of both fee schedules.
6. Streams the ranked results to the browser over Server-Sent Events.

The **Arbitrage** tab ranks every cross-book pair by net edge. The **Odds feed** tab is the raw
two-column board — what Kalshi is asking, what Novig is asking, for every market they share.

## Sizing

One leg is pinned to a target stake — **$100 by default** — and the other is sized to match it
contract-for-contract, which is what makes the payout identical whichever way the market settles.
Change the amount in the header, and use *Which leg gets it* to choose:

- **Larger leg** (default) — the more expensive side gets the $100, so no single leg goes over it.
- **Kalshi leg** / **Novig leg** — pin a specific venue.

Size is capped by whatever the two books can actually fill. Click any row to open the bet slip:
contracts, average fill price, slippage against the quoted top, stake, fee, and the market
identifier to paste into each venue.

## Reading the numbers

**Gross** is the edge before fees: `1 − (priceA + priceB)`. **Net edge** is what you keep.

The gap between them is usually the whole story, because Kalshi's trading fee is quadratic:

```
Kalshi fee  =  ceil( 0.07 × multiplier × contracts × P × (1−P) )    rounded up to the cent
Novig fee   =  0.03 × contracts × P × (1−P)                          live games only
```

At even money that Kalshi fee is **1.75¢ per contract** — so a 1% gross edge is a losing trade,
and you need roughly 1.8% gross before the lock clears. Two things move in your favour:

- **Novig charges nothing before kickoff.** Pre-game fills are free on that leg, so pre-game
  locks only have to cover the Kalshi side.
- **Some Kalshi series are cheaper.** MLB game/spread/total carry a 0.5× multiplier, halving the
  fee. Novigarb reads each series' real `fee_multiplier` from the API rather than assuming one rate.

That is why the board often shows plenty of 1% gross edges and no profitable arbitrage. It is not
a bug — it is the fee wall, and the **Gross** column is there so you can see exactly where the
edge went. Untick *Profitable only* (the default) to watch how close the books are running.

**Best size** is the position that makes the most money on current depth, found by evaluating the
profit at every order-book breakpoint. A thin best level with a bad second level will show a small
best size — that is the honest number.

## Markets covered

| | |
|---|---|
| **Two-way moneyline** | MLB, NFL, NBA, NHL, WNBA, NCAAF, NCAAB, CFL, ATP, WTA |
| **Three-way (win / draw)** | Premier League, La Liga, Serie A, Ligue 1, Bundesliga, MLS, Champions League, Europa League |
| **Spreads and totals** | every league above that lists them on both venues |

Leagues are only scanned when Novig actually has open fixtures for them, so the scan shrinks and
grows with the sporting calendar.

## Configuration

All optional, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Web server port |
| `POLL_MS` | `8000` | Pause between scans (a scan takes ~2–3s) |
| `TARGET_STAKE` | `100` | Starting stake for the anchor leg |
| `NEAR_MISS_EDGE` | `-0.02` | Screen-in threshold; pairs below this are not order-book priced |
| `KALSHI_FEE_COEFFICIENT` | `0.07` | Kalshi's quadratic coefficient |
| `NOVIG_FEE_COEFFICIENT` | `0.03` | Novig's live taker coefficient |
| `BOARD_LIMIT` | `500` | Odds-feed rows sent to the browser |

```bash
PORT=9000 TARGET_STAKE=250 node server.js
```

Both fee coefficients are published schedules that can change — Novig explicitly says to read the
rate from their fees page rather than hardcoding it. Check
[Novig's fee page](https://docs.novig.com/fees) and Kalshi's fee schedule, and override here if
they move.

## How matching works

Getting the fixtures paired correctly is most of the problem. The books disagree constantly:

- Kalshi calls the Nationals `WSH`, Novig calls them `WAS`.
- Novig uses `CHI` for **both** Chicago baseball clubs; Kalshi splits them into `CHC` and `CWS`.
- Kalshi truncates names — `Chicago WS`, `New York M` — where Novig spells them out.
- Soccer fixtures list home and away in opposite order across the two venues.

So matching scores team names rather than trusting abbreviations: exact tokens, prefixes
(`M` → `Mets`), and acronyms (`WS` → `White Sox`), combined with abbreviation equality, gated on
an Eastern-time date window and resolved greedily one-to-one.

Sides are then anchored to **Novig's** home/away orientation, and every Kalshi market is mapped to
a team by identity — never by position. That is what keeps a home/away disagreement from silently
inverting a leg, which would turn a "lock" into two bets on the same outcome.

Each row shows its match confidence in the bet slip. Anything below 70% is discarded.

## Data sources

Both are public, read-only, and unauthenticated:

- **Kalshi** — REST Trade API, `https://external-api.kalshi.com/trade-api/v2`
  ([market data quickstart](https://docs.kalshi.com/getting_started/quick_start_market_data))
- **Novig** — GraphQL, `https://gql.novig.us/v1/graphql`
  ([overview](https://docs.novig.com/api-reference/graphql/overview))

Two details worth knowing if you extend this:

- Kalshi order books contain **bids only**. A NO bid at `q` is a YES ask at `1 − q` for the same
  size, which is how the ask ladders in `src/kalshi.js` are derived.
- Novig orders are **all bids**, and `qty` is in cents of payout (100 `qty` = one $1 contract). A
  bid on one outcome is offered liquidity on its sibling — see `askLadderFromSiblingBids`.
- Novig's GraphQL endpoint enforces a 4-second statement timeout, so queries are sharded and
  order depth is fetched separately from prices.

## Layout

```
server.js            HTTP server, SSE stream, settings endpoint
src/config.js        tunables, fee schedules, league -> Kalshi series map
src/kalshi.js        Kalshi adapter: fixtures, order books, fee model
src/novig.js         Novig adapter: events, markets, bid ladders, fee model
src/teams.js         team-name normalisation and similarity scoring
src/match.js         fixture matching and canonical contract construction
src/arb.js           book walking, lock pricing, optimal sizing
src/engine.js        scan orchestration
public/              dashboard
scripts/scan-once.js one-shot terminal scan
```

## Caveats

This finds and prices opportunities. It does not place bets, and there is no trading code in it.

Quotes move between the scan and your click, a leg can fill partially, and a lock with one leg
filled is just a directional bet. Order books are also snapshots — size shown at a price can be
gone before you get there. Treat every row as a lead to verify on the venue, not a filled ticket.

Novig's GraphQL API is documented as deprecated in favour of their authenticated REST API. It is
live and unauthenticated today, which is what makes this run without keys; if it is retired,
`src/novig.js` is the only file that needs to change.
