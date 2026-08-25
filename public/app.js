// Dashboard client. Subscribes to the scan stream, renders the lock ledger and the
// cross-book odds feed, and keeps the sizing controls in step with the engine.

const el = (id) => document.getElementById(id);

const VIEWS = {
  arbs: { tab: 'tabArbs', panel: 'viewArbs', body: 'bodyArbs', blank: 'blankArbs' },
  board: { tab: 'tabBoard', panel: 'viewBoard', body: 'bodyBoard', blank: 'blankBoard' },
};

const state = {
  snapshot: null,
  view: 'arbs',
  expanded: new Set(),
  lastEdge: new Map(),
  filters: { league: '', market: '', search: '', profitOnly: false, liveOnly: false },
};

// ---------- formatting ----------

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const signedPct = (v) => `${v > 0 ? '+' : ''}${pct(v)}`;
const money = (v) => `$${Number(v).toFixed(2)}`;
const count = (n) => Number(n).toLocaleString();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function kickoff(iso, isLive) {
  if (isLive) return 'In play';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 0) return 'Under way';
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const icon = (name, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------- connection ----------

let lastMessageAt = 0;
let adoptedSettings = false;

function connect() {
  const stream = new EventSource('/api/stream');

  stream.onmessage = (ev) => {
    lastMessageAt = Date.now();
    state.snapshot = JSON.parse(ev.data);
    syncLeagues();

    // The engine holds its settings across reloads; adopt them on the first frame so
    // the rail never advertises a stake the scanner is not actually using.
    if (!adoptedSettings) {
      adoptedSettings = true;
      el('stake').value = state.snapshot.settings.targetStake;
      el('anchor').value = state.snapshot.settings.anchor;
      updateRubric();
    }

    render();
  };

  stream.onerror = () => setConnection('down', 'Feed dropped — retrying');
}

function setConnection(kind, text) {
  el('beacon').dataset.state = kind;
  el('connectionText').textContent = text;
}

setInterval(() => {
  if (!lastMessageAt) return;
  const age = Math.round((Date.now() - lastMessageAt) / 1000);
  if (age > 30) setConnection('down', `Silent for ${age}s`);
  else if (age > 14) setConnection('stale', `${age}s since last scan`);
  else setConnection('live', age <= 1 ? 'Just scanned' : `Scanned ${age}s ago`);
}, 1000);

function showBanner(title, body) {
  el('bannerTitle').textContent = title;
  el('bannerBody').textContent = body;
  el('banner').hidden = false;
}

// ---------- controls ----------

function updateRubric() {
  const amount = Number(el('stake').value) || 100;
  el('rubricStake').textContent = money(amount).replace(/\.00$/, '');
}

function pushSettings() {
  updateRubric();
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetStake: Number(el('stake').value) || 100,
      anchor: el('anchor').value,
    }),
  }).catch(() => showBanner('Could not update sizing. ', 'The scanner is still using the previous wager.'));
}

el('stake').addEventListener('change', pushSettings);
el('stake').addEventListener('input', updateRubric);
el('anchor').addEventListener('change', pushSettings);

for (const key of ['league', 'market']) {
  el(key).addEventListener('change', (e) => {
    state.filters[key] = e.target.value;
    render();
  });
}

el('search').addEventListener('input', (e) => {
  state.filters.search = e.target.value.trim().toLowerCase();
  render();
});

for (const key of ['profitOnly', 'liveOnly']) {
  el(key).addEventListener('change', (e) => {
    state.filters[key] = e.target.checked;
    render();
  });
}

for (const [name, refs] of Object.entries(VIEWS)) {
  el(refs.tab).addEventListener('click', () => {
    state.view = name;
    for (const [other, otherRefs] of Object.entries(VIEWS)) {
      el(otherRefs.tab).setAttribute('aria-selected', String(other === name));
      el(otherRefs.panel).hidden = other !== name;
    }
    render();
  });
}

function syncLeagues() {
  const select = el('league');
  const seen = new Set();
  for (const o of state.snapshot.opportunities) seen.add(o.league);
  for (const b of state.snapshot.board) seen.add(b.league);

  const wanted = [...seen].sort();
  const current = [...select.options].slice(1).map((o) => o.value);
  if (current.join('|') === wanted.join('|')) return;

  const keep = select.value;
  select.innerHTML = '<option value="">Every league</option>';
  for (const name of wanted) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = keep;
}

// ---------- filtering ----------

function passes(row, type, live) {
  const f = state.filters;
  if (f.league && row.league !== f.league) return false;
  if (f.market && type !== f.market) return false;
  if (f.liveOnly && !live) return false;
  if (f.search && !`${row.fixture} ${row.marketLabel} ${row.league}`.toLowerCase().includes(f.search)) return false;
  return true;
}

// ---------- render ----------

function skeleton(columns, rows = 6) {
  const cells = Array.from({ length: columns }, () => '<td><span class="bone"></span></td>').join('');
  return Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join('');
}

function render() {
  const snap = state.snapshot;

  if (!snap) {
    el('bodyArbs').innerHTML = skeleton(6);
    el('bodyBoard').innerHTML = skeleton(5);
    return;
  }

  el('statFixtures').textContent = count(snap.stats.matchedFixtures);
  el('statMarkets').textContent = count(snap.stats.pairsScreened);
  el('statLocks').textContent = count(snap.stats.opportunities);
  el('statLocks').dataset.flag = snap.stats.opportunities > 0 ? 'on' : 'off';
  el('statScan').textContent = snap.cycleMs ? `${(snap.cycleMs / 1000).toFixed(1)}s` : '—';

  el('boardNote').textContent =
    snap.boardTotal > snap.board.length
      ? ` Showing the ${count(snap.board.length)} tightest of ${count(snap.boardTotal)} matched markets.`
      : '';

  if (snap.errors?.length) {
    showBanner('Part of the last scan failed. ', `${snap.errors[0]} — those markets are missing from this pass.`);
  } else {
    el('banner').hidden = true;
  }

  if (state.view === 'arbs') renderArbs(snap);
  else renderBoard(snap);
}

function renderArbs(snap) {
  const rows = snap.opportunities.filter(
    (o) => passes(o, o.marketType, o.isLive) && (!state.filters.profitOnly || o.profit > 0)
  );

  const blank = el('blankArbs');
  blank.hidden = rows.length > 0;
  if (!rows.length) {
    const filtered = state.filters.league || state.filters.market || state.filters.search || state.filters.liveOnly;
    if (state.filters.profitOnly) {
      el('blankArbsTitle').textContent = 'No locks at the moment';
      el('blankArbsBody').textContent =
        'Both books are pricing everything above break-even once fees are in. Untick “Locks only” to see how close they are running.';
    } else if (filtered) {
      el('blankArbsTitle').textContent = 'Nothing under these filters';
      el('blankArbsBody').textContent = 'Widen the league, market or search and the board will fill back in.';
    } else {
      el('blankArbsTitle').textContent = 'Nothing on the board';
      el('blankArbsBody').textContent = 'The scanner found no fixture quoted on both venues in this pass.';
    }
  }

  const nextEdge = new Map();
  const body = el('bodyArbs');
  body.innerHTML = rows.map((o) => arbRow(o, nextEdge)).join('');
  state.lastEdge = nextEdge;

  for (const tr of body.querySelectorAll('tr.entry')) {
    tr.addEventListener('click', () => toggle(tr.dataset.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(tr.dataset.id);
      }
    });
  }
}

function toggle(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

function wagerCell(leg, anchored) {
  const venue = leg.book === 'kalshi' ? 'Kalshi' : 'Novig';
  const action = leg.side ? `Buy ${leg.side.toUpperCase()} · ` : '';
  // A Kalshi NO on "New England" pays if Seattle wins, so when the market traded is not
  // the outcome itself, name it on its own line rather than burying it mid-sentence.
  const onMarket =
    leg.marketName && leg.marketName !== leg.label
      ? `<div class="wager-price muted" title="${esc(leg.marketName)}">on ${esc(leg.marketName)}</div>`
      : '';
  return `
    <td>
      <div class="wager">
        <div class="wager-head">
          <span class="venue ${leg.book}">${venue}</span>
          ${anchored ? '' : '<span class="wager-price">sized to match</span>'}
        </div>
        <div class="wager-amount">${money(leg.stake)}${anchored ? '<span class="pinned">Fixed</span>' : ''}</div>
        <div class="wager-pick" title="${esc(leg.label)}">${esc(leg.label)}</div>
        <div class="wager-price">${action}${count(leg.contracts)} @ ${leg.avgPrice} · ${esc(leg.american)}</div>
        ${onMarket}
      </div>
    </td>`;
}

function arbRow(o, nextEdge) {
  const kalshi = o.legs.find((l) => l.book === 'kalshi');
  const novig = o.legs.find((l) => l.book === 'novig');
  const open = state.expanded.has(o.id);
  const isLock = o.profit > 0;

  const previous = state.lastEdge.get(o.id);
  nextEdge.set(o.id, o.netRoi);

  const row = `
    <tr class="entry" data-id="${esc(o.id)}" tabindex="0" aria-expanded="${open}">
      <td>
        <div class="figure ${isLock ? 'gain' : 'flat'}">${signedPct(o.netRoi)}</div>
        <div class="gloss mono">${pct(o.grossEdge)} gross</div>
      </td>
      <td>
        <div class="matchup">${esc(o.fixture)}</div>
        <div class="market-line">${esc(o.marketLabel)}</div>
        <div class="gloss">
          <span class="tag">${esc(o.league)}</span>
          <span class="tag ${o.isLive ? 'now' : ''}">${esc(kickoff(o.startsAt, o.isLive))}</span>
        </div>
      </td>
      ${wagerCell(kalshi, o.anchoredBook === 'kalshi')}
      ${wagerCell(novig, o.anchoredBook === 'novig')}
      <td class="right">
        <div class="figure">${money(o.totalCost)}</div>
        <div class="gloss mono">returns ${money(o.payout)}</div>
      </td>
      <td class="right">
        <div class="figure ${isLock ? 'gain' : 'flat'}">${money(o.profit)}</div>
        <div class="gloss mono">${o.bestSize ? `best ${count(o.bestSize)} @ ${money(o.bestProfit)}` : 'no size clears'}</div>
      </td>
    </tr>`;

  return open ? row + slipRow(o, kalshi, novig) : row;
}

function slipRow(o, kalshi, novig) {
  const isLock = o.profit > 0;

  const card = (leg, anchored) => `
    <div class="slip-card">
      <h3><span class="venue ${leg.book}">${leg.book === 'kalshi' ? 'Kalshi' : 'Novig'}</span> ${esc(leg.label)}</h3>
      <dl>
        <dt>Wager</dt><dd>${money(leg.stake)} ${anchored ? '<em>fixed</em>' : '<em>sized</em>'}</dd>
        <dt>Action</dt><dd>${leg.side ? `Buy ${leg.side.toUpperCase()}` : 'Back this outcome'}</dd>
        ${leg.marketName && leg.marketName !== leg.label ? `<dt>On market</dt><dd>${esc(leg.marketName)}</dd>` : ''}
        <dt>Contracts</dt><dd>${count(leg.contracts)}</dd>
        <dt>Average fill</dt><dd>${leg.avgPrice} <em>${esc(leg.american)}</em></dd>
        <dt>Quoted top</dt><dd>${leg.quotedPrice}</dd>
        <dt>Slippage</dt><dd>${(leg.slippage || 0).toFixed(4)}</dd>
        <dt>Fee</dt><dd>${leg.fee ? money(leg.fee) : '$0.00 <em>pre-game</em>'}</dd>
      </dl>
      <p class="ticket">${esc(leg.ticker || leg.outcomeId || '')}</p>
    </div>`;

  return `
    <tr class="slip">
      <td colspan="6">
        <div class="slip-grid">
          ${card(kalshi, o.anchoredBook === 'kalshi')}
          ${card(novig, o.anchoredBook === 'novig')}
          <div class="slip-card verdict">
            <p class="caption-line">${isLock ? 'Locked profit' : 'Shortfall'}</p>
            <div class="headline ${isLock ? 'gain' : 'flat'}">${money(o.profit)}</div>
            <dl>
              <dt>Staked</dt><dd>${money(o.stake)}</dd>
              <dt>Fees</dt><dd>${money(o.fees)}</dd>
              <dt>At risk</dt><dd>${money(o.totalCost)}</dd>
              <dt>Returns</dt><dd>${money(o.payout)}</dd>
              <dt>Net edge</dt><dd>${signedPct(o.netRoi)}</dd>
            </dl>
            <p class="prose">
              ${count(o.contracts)} contracts a side returns ${money(o.payout)} whichever way it settles.
              ${o.bestSize > 0
                ? `Current depth pays best at ${count(o.bestSize)} contracts, for ${money(o.bestProfit)}.`
                : `The ${pct(o.grossEdge)} gross edge does not survive ${money(o.fees)} of fees at any size.`}
              Fixtures paired at ${(o.matchScore * 100).toFixed(0)}% confidence.
            </p>
          </div>
        </div>
      </td>
    </tr>`;
}

function renderBoard(snap) {
  const rows = snap.board.filter((b) => passes(b, b.marketType, b.isLive));
  el('blankBoard').hidden = rows.length > 0;

  el('bodyBoard').innerHTML = rows
    .map(
      (b) => `
      <tr>
        <td>
          <div class="matchup">${esc(b.fixture)}</div>
          <div class="gloss">
            <span class="tag">${esc(b.league)}</span>
            <span class="tag ${b.isLive ? 'now' : ''}">${esc(kickoff(b.startsAt, b.isLive))}</span>
          </div>
        </td>
        <td><div class="market-line">${esc(b.marketLabel)}</div></td>
        <td class="right">
          <div class="figure">${b.kalshi.price}</div>
          <div class="gloss mono">${esc(b.kalshi.american)}</div>
        </td>
        <td class="right">
          <div class="figure">${b.novig.price}</div>
          <div class="gloss mono">${esc(b.novig.american)}</div>
        </td>
        <td class="right">
          <div class="figure ${b.bestEdge > 0 ? 'gain' : 'flat'}">${b.bestEdge === null ? '—' : signedPct(b.bestEdge)}</div>
        </td>
      </tr>`
    )
    .join('');
}

render();
connect();
