// Team identity resolution across books.
//
// Kalshi and Novig disagree on abbreviations (Nationals are WSH vs WAS) and Novig
// reuses CHI for both Chicago baseball clubs, so abbreviation equality alone is not
// enough. Kalshi also truncates names ("Chicago WS", "New York M") where Novig spells
// them out ("Chicago White Sox", "New York Mets"). Scoring blends both signals.

const NOISE_TOKENS = new Set(['fc', 'afc', 'cf', 'sc', 'the', 'club', 'de']);

// Team names repeat constantly across a scan (every market on a fixture names the same
// two teams), so tokenizing is memoized. Names are a small, bounded set.
const tokenCache = new Map();

/** Lowercase, strip accents and punctuation, drop club-suffix noise. */
export function tokenize(name) {
  if (!name) return [];
  const cached = tokenCache.get(name);
  if (cached) return cached;
  const tokens = computeTokens(name);
  if (tokenCache.size < 20000) tokenCache.set(name, tokens);
  return tokens;
}

function computeTokens(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !NOISE_TOKENS.has(t));
}

/**
 * How well a (possibly truncated) Kalshi name matches a full Novig name, in [0,1].
 * Every Kalshi token must find a home: exactly, as a prefix, or as an acronym of a
 * run of Novig tokens ("ws" covering "white sox").
 */
function nameScore(shortName, fullName) {
  const shortTokens = tokenize(shortName);
  const fullTokens = tokenize(fullName);
  if (!shortTokens.length || !fullTokens.length) return 0;

  const used = new Array(fullTokens.length).fill(false);
  let matched = 0;

  for (const token of shortTokens) {
    let hit = false;

    // Exact, then prefix ("m" -> "mets", "manchester" -> "manchester").
    for (let i = 0; i < fullTokens.length && !hit; i++) {
      if (used[i]) continue;
      if (fullTokens[i] === token || fullTokens[i].startsWith(token)) {
        used[i] = true;
        hit = true;
      }
    }

    // Acronym over consecutive unused tokens ("ws" -> "white sox").
    if (!hit && token.length >= 2) {
      for (let i = 0; i < fullTokens.length && !hit; i++) {
        if (used[i]) continue;
        let acronym = '';
        for (let j = i; j < fullTokens.length && acronym.length < token.length; j++) {
          if (used[j]) break;
          acronym += fullTokens[j][0];
          if (acronym === token) {
            for (let k = i; k <= j; k++) used[k] = true;
            hit = true;
            break;
          }
        }
      }
    }

    if (hit) matched++;
  }

  return matched / shortTokens.length;
}

/**
 * Similarity of one Kalshi team to one Novig team, in [0,1].
 * `kalshi` is {name, abbr}; `novig` is {name, symbol}.
 */
export function teamScore(kalshi, novig) {
  let best = 0;

  if (kalshi.abbr && novig.symbol && kalshi.abbr.toUpperCase() === novig.symbol.toUpperCase()) {
    best = 1;
  }

  if (kalshi.name && novig.name) {
    best = Math.max(best, nameScore(kalshi.name, novig.name));
  }

  // Kalshi's abbreviation sometimes matches the Novig name better than its own
  // truncated name does (e.g. abbr "LFC" vs name "Liverpool").
  if (kalshi.abbr && novig.name) {
    best = Math.max(best, nameScore(kalshi.abbr, novig.name) * 0.9);
  }

  return best;
}

/**
 * Score a whole fixture, honouring home/away orientation. Returns the combined score
 * and whether the books agree on which side is home.
 */
export function fixtureScore(kalshiEvent, novigEvent) {
  const straight =
    teamScore(kalshiEvent.away, novigEvent.away) + teamScore(kalshiEvent.home, novigEvent.home);
  const flipped =
    teamScore(kalshiEvent.away, novigEvent.home) + teamScore(kalshiEvent.home, novigEvent.away);

  return straight >= flipped
    ? { score: straight / 2, flipped: false }
    : { score: flipped / 2, flipped: true };
}

// Constructing an Intl formatter is expensive; build it once.
const EASTERN_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date in US Eastern time — the timezone Kalshi encodes into event tickers. */
export function easternDateKey(date) {
  return EASTERN_DATE.format(date);
}
