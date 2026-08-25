// One-shot scan: run a single engine cycle and print the results. Useful for sanity
// checks and for confirming the matcher is pairing fixtures correctly.
import { Engine } from '../src/engine.js';

const engine = new Engine();
const t0 = Date.now();
await engine.cycle();
const s = engine.snapshot;

console.log('\n=== STATS ===');
console.log(JSON.stringify(s.stats, null, 1));
console.log('cycle ms:', s.cycleMs, '| wall ms:', Date.now() - t0);
if (s.errors.length) console.log('errors:', s.errors.slice(0, 5));

console.log(`\n=== BOARD (${s.board.length} matched contract sides, showing 10) ===`);
for (const b of s.board.slice(0, 10)) {
  console.log(`${b.league.padEnd(14)} ${b.fixture.slice(0, 34).padEnd(35)} ${b.marketLabel.slice(0, 30).padEnd(31)} K ${String(b.kalshi.price).padEnd(7)} N ${String(b.novig.price).padEnd(7)} edge ${b.bestEdge}`);
}

console.log(`\n=== TOP OPPORTUNITIES (${s.opportunities.length} priced) ===`);
for (const o of s.opportunities.slice(0, 15)) {
  const flag = o.profit > 0 ? 'ARB ' : '    ';
  console.log(`${flag}${(o.netRoi * 100).toFixed(2).padStart(7)}%  ${o.league.padEnd(13)} ${o.fixture.slice(0, 32).padEnd(33)} ${o.marketLabel.slice(0, 32).padEnd(33)} profit $${String(o.profit).padStart(7)} on $${String(o.totalCost).padStart(7)}`);
  for (const l of o.legs) {
    console.log(`        ${l.book.padEnd(7)} ${String(l.side || '').padEnd(4)} ${String(l.label).slice(0, 26).padEnd(27)} ${l.contracts}c @ ${l.avgPrice} = $${l.stake} (fee $${l.fee})`);
  }
}
