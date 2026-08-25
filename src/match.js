// Cross-book matching.
//
// Produces "contracts": canonical propositions that both books quote, each with two
// complementary sides. Everything is expressed in NOVIG's home/away orientation, so a
// disagreement about which team is home cannot silently invert a side.
//
// Contract keys
//   ML            two-way moneyline            sides HOME / AWAY
//   ML3:HOME|AWAY|DRAW   three-way result      sides YES / NO
//   TOT:<strike>  game total                   sides OVER / UNDER
//   SPR:<line>    spread, line signed for home sides HOME / AWAY
//   TT:<side>:<strike>       team total          sides OVER / UNDER
//   P:<stat>:<player>:<strike>  player prop      sides OVER / UNDER

import { teamScore, fixtureScore, easternDateKey, playerKey } from './teams.js';

export const COMPLEMENT = { HOME: 'AWAY', AWAY: 'HOME', OVER: 'UNDER', UNDER: 'OVER', YES: 'NO', NO: 'YES' };

const MIN_TEAM_SCORE = 0.5;
const MIN_FIXTURE_SCORE = 0.7;

/** Kalshi splits one fixture across GAME/SPREAD/TOTAL series that share a ticker suffix. */
export function groupKalshiFixtures(fixtures) {
  const groups = new Map();

  for (const f of fixtures) {
    const key = `${f.dateKey}|${f.eventTicker.slice(f.eventTicker.indexOf('-') + 1)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        dateKey: f.dateKey,
        hhmm: f.hhmm,
        away: f.away,
        home: f.home,
        title: f.title,
        byKind: {},
        props: [],
      });
    }
    const g = groups.get(key);
    if (f.kind === 'prop') g.props.push(f);
    else g.byKind[f.kind] = f;
    // The GAME series carries the cleanest team labels.
    if (f.kind === 'game') {
      g.away = f.away;
      g.home = f.home;
      g.title = f.title;
    }
  }

  return [...groups.values()];
}

/**
 * Pair Kalshi fixture groups with Novig events inside one league. Greedy best-first,
 * one-to-one, gated on a date window and a minimum name-similarity score.
 */
export function matchFixtures(kalshiGroups, novigEvents) {
  const candidates = [];

  // Kalshi's ticker date is an Eastern calendar date; resolve each side's date once
  // rather than inside the O(n*m) loop.
  const novigDated = [];
  for (const ne of novigEvents) {
    const start = new Date(ne.start);
    if (Number.isNaN(start.getTime())) continue;
    novigDated.push({ ne, day: Date.parse(`${easternDateKey(start)}T00:00:00Z`) });
  }

  for (const kg of kalshiGroups) {
    const kalshiDay = Date.parse(`${kg.dateKey}T00:00:00Z`);

    for (const { ne, day } of novigDated) {
      // Allow a day of slack for late games and for fixtures played outside North America.
      const dayGap = Math.abs((day - kalshiDay) / 86400000);
      if (!(dayGap <= 1)) continue;

      const { score } = fixtureScore(kg, ne);
      if (score < MIN_FIXTURE_SCORE) continue;
      candidates.push({ kalshi: kg, novig: ne, score, dayGap });
    }
  }

  // Prefer higher similarity, then the closer date.
  candidates.sort((a, b) => b.score - a.score || a.dayGap - b.dayGap);

  const usedKalshi = new Set();
  const usedNovig = new Set();
  const pairs = [];

  for (const c of candidates) {
    if (usedKalshi.has(c.kalshi.key) || usedNovig.has(c.novig.id)) continue;
    usedKalshi.add(c.kalshi.key);
    usedNovig.add(c.novig.id);
    pairs.push(c);
  }

  return pairs;
}

/** Which Novig side ('home'|'away') a Kalshi team label refers to, or null if unclear. */
function resolveSide(kalshiTeam, novigEvent) {
  const home = teamScore(kalshiTeam, novigEvent.home);
  const away = teamScore(kalshiTeam, novigEvent.away);
  if (Math.max(home, away) < MIN_TEAM_SCORE) return null;
  if (home === away) return null;
  return home > away ? 'home' : 'away';
}

/** Strip the trailing strike index off a spread market suffix: "MIA4" -> "MIA". */
function suffixTeam(suffix) {
  if (!suffix) return null;
  return suffix.replace(/\d+$/, '') || null;
}

const strikeKey = (n) => String(Number(n));

/**
 * Turn one matched fixture into a Map of contractKey -> { meta, sides: { SIDE: { kalshi[], novig[] } } }.
 * A leg records where to buy that side and at what quoted ask.
 */
export function buildContracts(pair, novigMarketsByEvent, league) {
  const { kalshi: kg, novig: ne } = pair;
  const contracts = new Map();

  const ensure = (key, meta) => {
    if (!contracts.has(key)) contracts.set(key, { key, meta, sides: {} });
    return contracts.get(key);
  };

  const addLeg = (key, meta, side, leg) => {
    const c = ensure(key, meta);
    if (!c.sides[side]) c.sides[side] = { kalshi: [], novig: [] };
    c.sides[side][leg.book].push(leg);
  };

  // ---- Kalshi legs -------------------------------------------------------------
  const homeName = ne.home.name;
  const awayName = ne.away.name;

  const gameFixture = kg.byKind.game;
  if (gameFixture) {
    for (const m of gameFixture.markets) {
      const isTie = /^(TIE|DRAW)$/i.test(m.suffix || '');
      let key = null;
      let yesSide = null;
      let noSide = null;
      // Label a leg by the outcome it pays on. A Kalshi NO on "New England wins" is a
      // bet on Seattle, and must never read back as "New England".
      let yesLabel = m.yesSubTitle || m.title;
      let noLabel = `Not ${yesLabel}`;

      if (league.drawPossible) {
        if (isTie) {
          key = 'ML3:DRAW';
          yesLabel = 'Draw';
          noLabel = 'No draw';
        } else {
          const side = resolveSide({ name: m.yesSubTitle, abbr: m.suffix }, ne);
          if (!side) continue;
          key = `ML3:${side.toUpperCase()}`;
          const team = side === 'home' ? homeName : awayName;
          yesLabel = `${team} to win`;
          noLabel = `${team} not to win`;
        }
        yesSide = 'YES';
        noSide = 'NO';
      } else {
        if (isTie) continue;
        const side = resolveSide({ name: m.yesSubTitle, abbr: m.suffix }, ne);
        if (!side) continue;
        key = 'ML';
        yesSide = side === 'home' ? 'HOME' : 'AWAY';
        noSide = COMPLEMENT[yesSide];
        // Two-way: the NO side simply is the other team.
        yesLabel = side === 'home' ? homeName : awayName;
        noLabel = side === 'home' ? awayName : homeName;
      }

      const marketName = m.yesSubTitle || m.title;
      const meta = { type: league.drawPossible ? 'moneyline3' : 'moneyline', label: yesLabel };
      if (m.yesAsk !== null) {
        addLeg(key, meta, yesSide, { book: 'kalshi', side: 'yes', marketName, ticker: m.ticker, seriesTicker: gameFixture.seriesTicker, price: m.yesAsk, topSize: m.yesAskSize, label: yesLabel });
      }
      if (m.noAsk !== null) {
        addLeg(key, meta, noSide, { book: 'kalshi', side: 'no', marketName, ticker: m.ticker, seriesTicker: gameFixture.seriesTicker, price: m.noAsk, topSize: m.noAskSize, label: noLabel });
      }
    }
  }

  const totalFixture = kg.byKind.total;
  if (totalFixture) {
    for (const m of totalFixture.markets) {
      if (m.floorStrike === null) continue;
      const key = `TOT:${strikeKey(m.floorStrike)}`;
      const meta = { type: 'total', strike: m.floorStrike, label: `Total ${m.floorStrike}` };
      const marketName = m.yesSubTitle || m.title;
      if (m.yesAsk !== null) {
        addLeg(key, meta, 'OVER', { book: 'kalshi', side: 'yes', marketName, ticker: m.ticker, seriesTicker: totalFixture.seriesTicker, price: m.yesAsk, topSize: m.yesAskSize, label: `Over ${m.floorStrike}` });
      }
      if (m.noAsk !== null) {
        addLeg(key, meta, 'UNDER', { book: 'kalshi', side: 'no', marketName, ticker: m.ticker, seriesTicker: totalFixture.seriesTicker, price: m.noAsk, topSize: m.noAskSize, label: `Under ${m.floorStrike}` });
      }
    }
  }

  const spreadFixture = kg.byKind.spread;
  if (spreadFixture) {
    for (const m of spreadFixture.markets) {
      if (m.floorStrike === null) continue;
      const abbr = suffixTeam(m.suffix);
      // "Miami wins by over 3.5 runs" -> the subject team is the favourite at -3.5.
      const subject = resolveSide({ name: m.yesSubTitle, abbr }, ne);
      if (!subject) continue;

      // Express the line against Novig's home team.
      const homeLine = subject === 'home' ? -m.floorStrike : m.floorStrike;
      const key = `SPR:${strikeKey(homeLine)}`;
      const meta = { type: 'spread', strike: homeLine, label: `Spread ${homeLine > 0 ? '+' : ''}${homeLine}` };

      const yesSide = subject === 'home' ? 'HOME' : 'AWAY';
      const noSide = COMPLEMENT[yesSide];

      // "Miami wins by over 3.5" is Miami -3.5; its NO is the opponent at +3.5.
      const subjectName = subject === 'home' ? homeName : awayName;
      const opponentName = subject === 'home' ? awayName : homeName;
      const yesLabel = `${subjectName} -${m.floorStrike}`;
      const noLabel = `${opponentName} +${m.floorStrike}`;

      const marketName = m.yesSubTitle || m.title;
      if (m.yesAsk !== null) {
        addLeg(key, meta, yesSide, { book: 'kalshi', side: 'yes', marketName, ticker: m.ticker, seriesTicker: spreadFixture.seriesTicker, price: m.yesAsk, topSize: m.yesAskSize, label: yesLabel });
      }
      if (m.noAsk !== null) {
        addLeg(key, meta, noSide, { book: 'kalshi', side: 'no', marketName, ticker: m.ticker, seriesTicker: spreadFixture.seriesTicker, price: m.noAsk, topSize: m.noAskSize, label: noLabel });
      }
    }
  }

  // ---- Kalshi team totals ------------------------------------------------------
  const teamTotalFixture = kg.byKind.teamTotal;
  if (teamTotalFixture) {
    for (const m of teamTotalFixture.markets) {
      if (m.floorStrike === null) continue;
      // Subtitles read "Miami over 1.5 runs scored"; the team is everything before "over".
      const subjectText = (m.yesSubTitle || '').replace(/\s+over\s.*$/i, '').trim();
      const subject = resolveSide({ name: subjectText, abbr: m.suffix }, ne);
      if (!subject) continue;

      const teamName = subject === 'home' ? homeName : awayName;
      const key = `TT:${subject.toUpperCase()}:${strikeKey(m.floorStrike)}`;
      const meta = { type: 'teamTotal', strike: m.floorStrike, subject, label: `${teamName} team total ${m.floorStrike}` };
      const marketName = m.yesSubTitle || m.title;

      if (m.yesAsk !== null) {
        addLeg(key, meta, 'OVER', { book: 'kalshi', side: 'yes', marketName, ticker: m.ticker, seriesTicker: teamTotalFixture.seriesTicker, price: m.yesAsk, topSize: m.yesAskSize, label: `${teamName} over ${m.floorStrike}` });
      }
      if (m.noAsk !== null) {
        addLeg(key, meta, 'UNDER', { book: 'kalshi', side: 'no', marketName, ticker: m.ticker, seriesTicker: teamTotalFixture.seriesTicker, price: m.noAsk, topSize: m.noAskSize, label: `${teamName} under ${m.floorStrike}` });
      }
    }
  }

  // ---- Kalshi player props -----------------------------------------------------
  // Both books quote these as over/under on the same `.5` line, so the only things that
  // must agree are the stat, the player and the strike.
  const propByStat = new Map((league.props || []).map((p) => [p.stat, p]));

  for (const propFixture of kg.props) {
    const statLabel = propByStat.get(propFixture.stat)?.label || propFixture.stat;

    for (const m of propFixture.markets) {
      if (m.floorStrike === null || !m.playerName) continue;
      const player = playerKey(m.playerName);
      if (!player) continue;

      const key = `P:${propFixture.stat}:${player.full}:${strikeKey(m.floorStrike)}`;
      const meta = {
        type: 'prop',
        stat: propFixture.stat,
        statLabel,
        strike: m.floorStrike,
        player: m.playerName,
        playerFull: player.full,
        playerShort: player.short,
        label: `${m.playerName} ${m.floorStrike}`,
      };
      const marketName = m.yesSubTitle || m.title;

      if (m.yesAsk !== null) {
        addLeg(key, meta, 'OVER', { book: 'kalshi', side: 'yes', marketName, ticker: m.ticker, seriesTicker: propFixture.seriesTicker, price: m.yesAsk, topSize: m.yesAskSize, label: `${m.playerName} over ${m.floorStrike}` });
      }
      if (m.noAsk !== null) {
        addLeg(key, meta, 'UNDER', { book: 'kalshi', side: 'no', marketName, ticker: m.ticker, seriesTicker: propFixture.seriesTicker, price: m.noAsk, topSize: m.noAskSize, label: `${m.playerName} under ${m.floorStrike}` });
      }
    }
  }

  // ---- Novig legs --------------------------------------------------------------
  const novigMarkets = novigMarketsByEvent.get(ne.id) || [];
  const propByNovigType = new Map((league.props || []).map((p) => [p.novig, p]));

  for (const m of novigMarkets) {
    // Outcome sidedness comes from `index`, never array order.
    const byIndex = new Map(m.outcomes.map((o) => [o.index, o]));
    const zero = byIndex.get(0);
    const one = byIndex.get(1);
    if (!zero || !one) continue;

    let key = null;
    let sideOfIndex0 = null;
    let meta = null;
    // Labels for index 0 and index 1, when Novig's own description is not self-explanatory.
    let labels = null;

    if (m.type === 'MONEY' && !league.drawPossible) {
      key = 'ML';
      sideOfIndex0 = 'HOME';
      meta = { type: 'moneyline', label: 'Moneyline' };
      labels = [homeName, awayName];
    } else if (m.type === 'MONEYLINE_3_WAY_WIN' && league.drawPossible) {
      const side = m.competitor ? resolveSide({ name: m.competitor.name, abbr: m.competitor.symbol }, ne) : null;
      if (!side) continue;
      key = `ML3:${side.toUpperCase()}`;
      sideOfIndex0 = 'YES';
      meta = { type: 'moneyline3', label: m.competitor.name };
      const team = side === 'home' ? homeName : awayName;
      labels = [`${team} to win`, `${team} not to win`];
    } else if (m.type === 'MONEYLINE_3_WAY_DRAW' && league.drawPossible) {
      key = 'ML3:DRAW';
      sideOfIndex0 = 'YES';
      meta = { type: 'moneyline3', label: 'Draw' };
      labels = ['Draw', 'No draw'];
    } else if (m.type === 'TOTAL' && m.strike !== null) {
      key = `TOT:${strikeKey(m.strike)}`;
      sideOfIndex0 = 'OVER';
      meta = { type: 'total', strike: m.strike, label: `Total ${m.strike}` };
    } else if (m.type === 'SPREAD' && m.strike !== null) {
      key = `SPR:${strikeKey(m.strike)}`;
      sideOfIndex0 = 'HOME';
      meta = { type: 'spread', strike: m.strike, label: `Spread ${m.strike > 0 ? '+' : ''}${m.strike}` };
    } else if (m.type === 'TEAM_TOTAL' && m.strike !== null) {
      const subject = m.competitor
        ? resolveSide({ name: m.competitor.name, abbr: m.competitor.symbol }, ne)
        : null;
      if (!subject) continue;
      const teamName = subject === 'home' ? homeName : awayName;
      key = `TT:${subject.toUpperCase()}:${strikeKey(m.strike)}`;
      sideOfIndex0 = 'OVER';
      meta = { type: 'teamTotal', strike: m.strike, subject, label: `${teamName} team total ${m.strike}` };
      labels = [`${teamName} over ${m.strike}`, `${teamName} under ${m.strike}`];
    } else if (propByNovigType.has(m.type) && m.strike !== null && m.player) {
      const prop = propByNovigType.get(m.type);
      const player = playerKey(m.player.name);
      if (!player) continue;
      key = `P:${prop.stat}:${player.full}:${strikeKey(m.strike)}`;
      sideOfIndex0 = 'OVER';
      meta = {
        type: 'prop',
        stat: prop.stat,
        statLabel: prop.label,
        strike: m.strike,
        player: m.player.name,
        playerFull: player.full,
        playerShort: player.short,
        label: `${m.player.name} ${m.strike}`,
      };
      labels = [`${m.player.name} over ${m.strike}`, `${m.player.name} under ${m.strike}`];
    } else {
      continue;
    }

    const sideOfIndex1 = COMPLEMENT[sideOfIndex0];

    for (const [outcome, side, index] of [[zero, sideOfIndex0, 0], [one, sideOfIndex1, 1]]) {
      if (outcome.available === null) continue;
      addLeg(key, meta, side, {
        book: 'novig',
        marketId: m.id,
        outcomeId: outcome.id,
        siblingOutcomeId: outcome === zero ? one.id : zero.id,
        price: outcome.available,
        label: labels ? labels[index] : outcome.description || outcome.type,
        isLive: ne.isLive,
      });
    }
  }

  return contracts;
}
