// Dashboard client: subscribes to the scan stream and renders the arbitrage table
// and the cross-book odds feed.

const el = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  view: 'arbs',
  expanded: new Set(),
  lastEdge: new Map(),   // opportunity id -> last edge, used to flash changed rows
  nextEdge: new Map(),   // rebuilt each render so the map tracks only current rows
  filters: {
    league: '',
    market: '',
    search: '',
    profitOnly: false,
    liveOnly: false,
  },
};

// ---------- formatting ----------

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const money = (v) => `$${Number(v).toFixed(2)}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startLabel(iso, isLive) {
  if (isLive) return 'in play';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 0) return 'started';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 24) return `in ${Math.round(mins / 60)}h`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- connection ----------

let stream;
let lastMessageAt = 0;
let adoptedSettings = false;

function connect() {
  stream = new EventSource('/api/stream');

  stream.onmessage = (ev) => {
    lastMessageAt = Date.now();
    state.snapshot = JSON.parse(ev.data);
    syncLeagueOptions();
    // The engine keeps its settings across page loads; adopt them on first frame so a
    // reload never shows a stake the scanner is not actually using.
    if (!adoptedSettings) {
      adoptedSettings = true;
      el('stake').value = state.snapshot.settings.targetStake;
      el('anchor').value = state.snapshot.settings.anchor;
    }
    render();
  };

  stream.onerror = () => setStatus('down', 'reconnecting…');
}

function setStatus(kind, text) {
  el('dot').className = `dot ${kind}`;
  el('statusText').textContent = text;
}

setInterval(() => {
  if (!lastMessageAt) return;
  const age = Math.round((Date.now() - lastMessageAt) / 1000);
  if (age > 30) setStatus('down', `no data for ${age}s`);
  else if (age > 12) setStatus('stale', `updated ${age}s ago`);
  else setStatus('live', `updated ${age}s ago`);
}, 1000);

// ---------- controls ----------

function pushSettings() {
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetStake: Number(el('stake').value) || 100,
      anchor: el('anchor').value,
    }),
  }).catch(() => {});
}

el('stake').addEventListener('change', pushSettings);
el('anchor').addEventListener('change', pushSettings);

for (const [id, key] of [['league', 'league'], ['market', 'market']]) {
  el(id).addEventListener('change', (e) => {
    state.filters[key] = e.target.value;
    render();
  });
}

el('search').addEventListener('input', (e) => {
  state.filters.search = e.target.value.trim().toLowerCase();
  render();
});

for (const [id, key] of [['profitOnly', 'profitOnly'], ['liveOnly', 'liveOnly']]) {
  el(id).addEventListener('change', (e) => {
    state.filters[key] = e.target.checked;
    render();
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    el('arbsView').hidden = state.view !== 'arbs';
    el('boardView').hidden = state.view !== 'board';
    render();
  });
}

function syncLeagueOptions() {
  const select = el('league');
  const seen = new Set();
  for (const o of state.snapshot.opportunities) seen.add(o.league);
  for (const b of state.snapshot.board) seen.add(b.league);

  const wanted = [...seen].sort();
  const current = [...select.options].slice(1).map((o) => o.value);
  if (current.join('|') === wanted.join('|')) return;

  const keep = select.value;
  select.innerHTML = '<option value="">All leagues</option>';
  for (const name of wanted) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = keep;
}

// ---------- filtering ----------

function matchesFilters(row, { type, live }) {
  const f = state.filters;
  if (f.league && row.league !== f.league) return false;
  if (f.market && type !== f.market) return false;
  if (f.liveOnly && !live) return false;
  if (f.search) {
    const hay = `${row.fixture} ${row.marketLabel} ${row.league}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

// ---------- render ----------

function render() {
  const snap = state.snapshot;
  if (!snap) return;

  el('statFixtures').textContent = snap.stats.matchedFixtures.toLocaleString();
  el('statPairs').textContent = snap.stats.pairsScreened.toLocaleString();
  el('statArbs').textContent = snap.stats.opportunities.toLocaleString();
  el('statCycle').textContent = snap.cycleMs ? `${(snap.cycleMs / 1000).toFixed(1)}s` : '—';
  el('boardNote').textContent = snap.boardTotal > snap.board.length
    ? ` Showing the ${snap.board.length} tightest of ${snap.boardTotal} matched markets.`
    : '';

  if (state.view === 'arbs') renderArbs(snap);
  else renderBoard(snap);
}

function renderArbs(snap) {
  const rows = snap.opportunities.filter(
    (o) => matchesFilters(o, { type: o.marketType, live: o.isLive }) && (!state.filters.profitOnly || o.profit > 0)
  );

  const body = el('arbsBody');
  el('arbsEmpty').hidden = rows.length > 0;
  el('arbsEmpty').textContent = state.filters.profitOnly
    ? 'No profitable arbitrage right now. Untick “Profitable only” to see how close the books are.'
    : 'No markets match these filters.';

  state.nextEdge = new Map();
  body.innerHTML = rows.map(renderArbRow).join('');
  state.lastEdge = state.nextEdge;

  for (const tr of body.querySelectorAll('tr.row')) {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
    });
  }
}

function renderArbRow(o) {
  const kalshiLeg = o.legs.find((l) => l.book === 'kalshi');
  const novigLeg = o.legs.find((l) => l.book === 'novig');
  const open = state.expanded.has(o.id);

  const prev = state.lastEdge.get(o.id);
  const changed = prev !== undefined && Math.abs(prev - o.netRoi) > 1e-6;
  state.nextEdge.set(o.id, o.netRoi);

  const main = `
    <tr class="row ${open ? 'open' : ''} ${changed ? 'flash' : ''}" data-id="${esc(o.id)}">
      <td class="edge ${o.profit > 0 ? 'pos' : 'neg'}">${o.profit > 0 ? '+' : ''}${pct(o.netRoi)}</td>
      <td class="num" style="color:${o.grossEdge > 0 ? 'var(--muted)' : 'var(--dim)'}">${pct(o.grossEdge)}</td>
      <td><span class="pill league">${esc(o.league)}</span></td>
      <td>
        <div class="fixture">${esc(o.fixture)}</div>
        <div class="sub">${o.isLive ? '<span class="pill live">Live</span> ' : ''}${esc(startLabel(o.startsAt, o.isLive))}</div>
      </td>
      <td>${esc(o.marketLabel)}</td>
      <td class="num">
        <div class="book-cell">
          <span class="pill kalshi">K</span>
          <span class="leg-label" title="${esc(kalshiLeg.label)}">${esc(kalshiLeg.label)}</span>
          <b>${kalshiLeg.avgPrice}</b>
        </div>
        <div class="sub">${esc(kalshiLeg.american)}</div>
      </td>
      <td class="num">
        <div class="book-cell">
          <span class="pill novig">N</span>
          <span class="leg-label" title="${esc(novigLeg.label)}">${esc(novigLeg.label)}</span>
          <b>${novigLeg.avgPrice}</b>
        </div>
        <div class="sub">${esc(novigLeg.american)}</div>
      </td>
      <td class="num">${money(o.totalCost)}</td>
      <td class="num" style="color:${o.profit > 0 ? 'var(--green)' : 'var(--dim)'}">${money(o.profit)}</td>
      <td class="num">${o.bestSize ? `${o.bestSize.toLocaleString()}c<div class="sub">${money(o.bestProfit)}</div>` : '—'}</td>
    </tr>`;

  return open ? main + renderSlip(o) : main;
}

function renderSlip(o) {
  const legHtml = (leg) => `
    <div class="leg">
      <h4><span class="pill ${leg.book}">${leg.book === 'kalshi' ? 'Kalshi' : 'Novig'}</span> ${esc(leg.label)}</h4>
      <dl>
        <dt>Buy</dt><dd>${leg.contracts.toLocaleString()} contracts</dd>
        <dt>Avg price</dt><dd>${leg.avgPrice} (${esc(leg.american)})</dd>
        <dt>Quoted top</dt><dd>${leg.quotedPrice}</dd>
        <dt>Slippage</dt><dd>${leg.slippage ? leg.slippage.toFixed(4) : '0.0000'}</dd>
        <dt>Stake</dt><dd>${money(leg.stake)}</dd>
        <dt>Fee</dt><dd>${leg.fee ? money(leg.fee) : '$0.00 (pre-game)'}</dd>
      </dl>
      <div class="ticket">${esc(leg.ticker || leg.outcomeId || '')}</div>
    </div>`;

  const kalshiLeg = o.legs.find((l) => l.book === 'kalshi');
  const novigLeg = o.legs.find((l) => l.book === 'novig');

  return `
    <tr class="slip">
      <td colspan="10">
        <div class="slip-inner">
          ${legHtml(kalshiLeg)}
          ${legHtml(novigLeg)}
          <div class="summary">
            <div class="big ${o.profit > 0 ? 'pos' : 'neg'}">${money(o.profit)}</div>
            <dl style="margin-top:8px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px">
              <dt style="color:var(--muted)">Total stake</dt><dd style="text-align:right;font-family:var(--mono)">${money(o.stake)}</dd>
              <dt style="color:var(--muted)">Fees</dt><dd style="text-align:right;font-family:var(--mono)">${money(o.fees)}</dd>
              <dt style="color:var(--muted)">At risk</dt><dd style="text-align:right;font-family:var(--mono)">${money(o.totalCost)}</dd>
              <dt style="color:var(--muted)">Returns</dt><dd style="text-align:right;font-family:var(--mono)">${money(o.payout)}</dd>
              <dt style="color:var(--muted)">Net ROI</dt><dd style="text-align:right;font-family:var(--mono)">${pct(o.netRoi)}</dd>
            </dl>
            <div class="note">
              ${o.contracts.toLocaleString()} contracts a side returns ${money(o.payout)} whichever way it settles.
              ${o.bestSize > 0
                ? `Best size on current depth is ${o.bestSize.toLocaleString()} contracts for ${money(o.bestProfit)}.`
                : `Gross edge is ${pct(o.grossEdge)}, but fees of ${money(o.fees)} turn it negative at every size.`}
              Fixture matched at ${(o.matchScore * 100).toFixed(0)}% confidence.
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}

function renderBoard(snap) {
  const rows = snap.board.filter((b) => matchesFilters(b, { type: b.marketType, live: b.isLive }));

  el('boardEmpty').hidden = rows.length > 0;
  el('boardEmpty').textContent = 'No markets match these filters.';

  el('boardBody').innerHTML = rows
    .map(
      (b) => `
      <tr>
        <td><span class="pill league">${esc(b.league)}</span></td>
        <td>
          <div class="fixture">${esc(b.fixture)}</div>
          <div class="sub">${b.isLive ? '<span class="pill live">Live</span> ' : ''}${esc(startLabel(b.startsAt, b.isLive))}</div>
        </td>
        <td>${esc(b.marketLabel)}</td>
        <td class="num">${b.kalshi.price}<div class="sub">${esc(b.kalshi.american)}</div></td>
        <td class="num">${b.novig.price}<div class="sub">${esc(b.novig.american)}</div></td>
        <td class="edge ${b.bestEdge > 0 ? 'pos' : 'neg'}">${b.bestEdge === null ? '—' : pct(b.bestEdge)}</td>
      </tr>`
    )
    .join('');
}

connect();
