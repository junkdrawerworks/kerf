// Checks Kerf's optimizer against brute force, and every sheet layout for overlaps.
// Run with: node test/solver.test.cjs   (no dependencies)
'use strict';
const fs = require('fs');
const path = require('path');

// The app is one HTML file; pull the pieces under test out of it by name.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing function ' + name);
  for (let k = src.indexOf('{', i), d = 0; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && !--d) return src.slice(i, k + 1);
  }
}
function list(name) {
  const i = src.indexOf('var ' + name + ' = ');
  return src.slice(i, src.indexOf('\n  ];', i) + 5);
}
function line(start) { const i = src.indexOf(start); return src.slice(i, src.indexOf('\n', i)); }
const SOLVER = [
  "var U = 'in';",
  line('var VULGAR = '), line('var EFFORT = '), line('var SPLITS = '), line('var MINR = '), list('SORTS'), list('FITS'),
  ...['esc', 'sixteenths', 'mmOf', 'fmt', 'fmtH', 'parseLen', 'mulberry', 'bestFill', 'onlyHave', 'solveBoards', 'orientations', 'newSheet',
    'placeIn', 'fitsStock', 'packRun', 'freeArea', 'evalSheets', 'sheetSteps', 'solveSheets'].map(fn),
];
const K = new Function([
  ...SOLVER,
  'return { parseLen: parseLen, fmt: fmt, fmtH: fmtH, solveBoards: solveBoards, solveSheets: solveSheets, units: function (u) { U = u; } };'
].join('\n'))();
// The page's own solveAll, with the plans it keeps between edits, noting the id of each material it plans (a full solve:
// the quick ones that look for tips aren't plans). `forget` drops the kept plans, as opening the page afresh does.
function planner() {
  return new Function([
    ...SOLVER, 'var P = null, RES = null, planned = [];', line('var PLANS = '), ...['lastIsLeft', 'cfg', 'solveMat', 'planInputs', 'solveAll'].map(fn),
    'var boards = solveBoards, sheets = solveSheets;',
    'solveBoards = function (m, c, quick) { if (!quick) planned.push(m.id); return boards(m, c, quick); };',
    'solveSheets = function (m, c, quick) { if (!quick) planned.push(m.id); return sheets(m, c, quick); };',
    'return { solve: function (p) { P = p; U = p.units; planned = []; return { res: solveAll(), planned: planned }; }, forget: function () { PLANS = {}; } };'
  ].join('\n'))();
}

// The page's tips search, run to its end: each idle step at once, in turn. Returns the plan's cost and the tips found.
function tipper() {
  return new Function([
    ...SOLVER, 'var P = null, RES = null, TIPS = [], GEN = 0, queue = [];', line('var PLANS = '), ...['lastIsLeft', 'cfg', 'solveMat', 'planInputs', 'solveAll', 'findTips'].map(fn),
    'function whenIdle(f) { queue.push(f); } function renderTips() {}',
    'return function (p) { P = p; U = p.units; solveAll(); GEN++; TIPS = []; findTips(GEN); while (queue.length) queue.shift()(); return { res: RES, tips: TIPS }; };'
  ].join('\n'))();
}

let failed = 0;
function check(ok, what) { if (!ok) { failed++; console.log('  FAIL ' + what); } }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const LUMBER = [[96, 4.28], [120, 6.38], [144, 7.68], [192, 10.98]];

// Cheapest possible cost by brute force: every piece into every open board or a new one.
function brute(pieces, stocks, kerf) {
  pieces = pieces.slice().sort((a, b) => b - a);
  let best = Infinity; const bins = [], left = stocks.map(s => s.left);
  (function go(i, cost) {
    if (cost >= best - 1e-9) return;
    if (i === pieces.length) { best = cost; return; }
    const p = pieces[i], seen = new Set();
    for (const b of bins) {
      const key = b.cap + ':' + b.used.toFixed(4); if (seen.has(key)) continue; seen.add(key);
      if (b.used + kerf + p <= b.cap + 1e-9) { const u = b.used; b.used += kerf + p; go(i + 1, cost); b.used = u; }
    }
    stocks.forEach((s, si) => {
      if (left[si] > 0 && p <= s.cap + 1e-9) { left[si]--; bins.push({ cap: s.cap, used: p }); go(i + 1, cost + s.price); bins.pop(); left[si]++; }
    });
  })(0, 0);
  return best;
}

console.log('lengths');
const inches = { '35 3/4': 35.75, '35-3/4': 35.75, '2\' 11 3/4"': 35.75, '8\'': 96, '8 ft': 96, '3/4': 0.75, '¾': 0.75, '1½"': 1.5, '910mm': 910 / 25.4, '2.4 m': 2400 / 25.4, 'abc': NaN, '1/0': NaN };
for (const [s, want] of Object.entries(inches)) {
  const got = K.parseLen(s);
  check(Number.isNaN(want) ? Number.isNaN(got) : Math.abs(got - want) < 1e-9, `parseLen(${JSON.stringify(s)}) = ${got}, want ${want}`);
}
check(K.fmt(35.75) === '35 3/4"' && K.fmt(96, { ft: true }) === "8'" && K.fmt(102.5, { ft: true }) === "8' 6 1/2\"", 'fmt in inches');
// Just under a whole foot rounds up to it, not to 12": 2438 mm is 8', not 7' 12".
for (const [x, want, wantH] of [[95.98, "8'", '8′'], [2438 / 25.4, "8'", '8′'], [107.97, "9'", '9′'], [191.975, "16'", '16′'], [95.96, "7' 11 15/16\"", '7′ 11 <span class="fr"><span class="sr">15/16</span><span aria-hidden="true"><sup>15</sup>⁄<sub>16</sub></span></span>″']]) {
  const got = K.fmt(x, { ft: true }), gotH = K.fmtH(x, { ft: true });
  check(got === want && gotH === wantH, `fmt(${x}, in feet) = ${got} and ${gotH}, want ${want}`);
}
K.units('mm'); check(K.parseLen('600') === 600 / 25.4 && K.fmt(600 / 25.4) === '600 mm', 'millimeters'); K.units('in');

console.log('boards: the example project');
{
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 }));
  const r = K.solveBoards({ stock, parts: [{ len: 72, qty: 4 }, { len: 48, qty: 8 }, { len: 21, qty: 8 }] }, { kerf: 0.125, trim: 0 });
  check(Math.abs(r.cost - 42.64) < 1e-6, `garage shelves 2×4s cost $${r.cost.toFixed(2)}, want $42.64`);
}

console.log('boards: on-hand boards that run short');
{
  // Only two boards on hand and nothing to buy: three legs can't all be cut, and the plan has to say so.
  let r = null;
  try { r = K.solveBoards({ stock: [{ len: 96, price: 0, have: 2 }], parts: [{ len: 72, qty: 3 }] }, { kerf: 0.125, trim: 0 }); } catch (e) { check(false, 'have 2 for 3 legs threw: ' + e.message); }
  if (r) check(r.items.length === 0 && r.errors.length === 1 && r.errors[0].pi === -1 && r.errors[0].only === 0, 'have 2 for 3 legs: ' + JSON.stringify(r.errors));
  r = K.solveBoards({ stock: [{ len: 96, price: 0, have: 3 }], parts: [{ len: 72, qty: 3 }] }, { kerf: 0.125, trim: 0 });
  check(r.items.length === 3 && r.cost === 0 && !r.errors.length, 'have 3 for 3 legs uses all three, free');
}

console.log('boards: random jobs against brute force (offcuts on hand, end trim, two kerfs)');
{
  const R = rng(17); let n = 0;
  for (let t = 0; t < 400; t++) {
    const trim = t % 3 === 0 ? 0.5 : 0, kerf = t % 2 ? 0.125 : 0.09375;
    const stock = LUMBER.slice(0, 2 + (t % 3)).map(s => ({ len: s[0], price: s[1], have: 0 }));
    if (R() < 0.6) stock.push({ len: Math.round(30 + R() * 60), price: 0, have: 1 + Math.floor(R() * 2) });
    const parts = [];
    for (let k = 0, nT = 1 + Math.floor(R() * 4); k < nT; k++) parts.push({ len: Math.round((6 + R() * 80) * 8) / 8, qty: 1 + Math.floor(R() * 3) });
    if (parts.reduce((a, p) => a + p.qty, 0) > 9) continue;
    const r = K.solveBoards({ stock, parts }, { kerf, trim });
    const pieces = []; parts.forEach(p => { for (let q = 0; q < p.qty; q++) pieces.push(p.len); });
    const best = brute(pieces, stock.map(s => ({ cap: s.len - 2 * trim, price: s.have ? 0 : s.price, left: s.have || Infinity })), kerf);
    const used = new Map(); r.items.forEach(b => used.set(b.stock, (used.get(b.stock) || 0) + 1));
    n++;
    check(r.cost <= best + 1e-6, `job ${t}: $${r.cost.toFixed(2)}, cheapest is $${best.toFixed(2)} ${JSON.stringify(parts)}`);
    check(stock.every(s => !s.have || (used.get(s) || 0) <= s.have), `job ${t}: used more offcuts than on hand`);
    check(r.items.every(b => b.need <= b.cap + 1e-9), `job ${t}: a board is overfilled`);
  }
  console.log('  ' + n + ' jobs');
}

console.log('boards: never dearer than first fit');
{
  // First fit, longest first, on one size to buy, each board then moved to the cheapest size it fits: the plain way to
  // plan boards by hand. Kerf's plan must never cost more. 24 pieces of 2×4 that Kerf planned at $44.02, where first
  // fit buys ten 8' boards for $42.80.
  const ffd = (pieces, stocks, kerf) => {
    let best = Infinity;
    for (const s0 of stocks) {
      const bins = []; let ok = true;
      for (const p of pieces.slice().sort((a, b) => b - a)) {
        const b = bins.find(b => b.used + kerf + p <= s0.cap + 1e-9);
        if (b) b.used += kerf + p; else if (p <= s0.cap + 1e-9) bins.push({ used: p }); else { ok = false; break; }
      }
      if (ok) best = Math.min(best, bins.reduce((a, b) => a + Math.min(...stocks.filter(s => s.cap + 1e-9 >= b.used).map(s => s.price)), 0));
    }
    return best;
  };
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 })), caps = LUMBER.map(s => ({ cap: s[0], price: s[1] }));
  const pieces = ps => [].concat(...ps.map(p => Array(p.qty).fill(p.len)));
  const job = [{ len: 18.25, qty: 4 }, { len: 89.75, qty: 3 }, { len: 33, qty: 5 }, { len: 35.75, qty: 6 }, { len: 29.5, qty: 6 }];
  let r = K.solveBoards({ stock, parts: job }, { kerf: 0.125, trim: 0 });
  check(r.cost <= 42.80 + 1e-6, `24 pieces of 2×4 cost $${r.cost.toFixed(2)}, first fit buys them for $42.80`);
  const R = rng(4); let n = 0;
  for (let t = 0; t < 150; t++) {
    const parts = [];
    for (let k = 0, nT = 2 + Math.floor(R() * 10); k < nT; k++) parts.push({ len: Math.round((6 + R() * 90) * 16) / 16, qty: 1 + Math.floor(R() * 8) });
    r = K.solveBoards({ stock, parts }, { kerf: 0.125, trim: 0 });
    const g = ffd(pieces(parts), caps, 0.125); n++;
    check(r.cost <= g + 1e-6, `job ${t}: $${r.cost.toFixed(2)}, first fit costs $${g.toFixed(2)} ${JSON.stringify(parts)}`);
  }
  console.log('  ' + n + ' jobs');
}

console.log('boards: a big job stays quick');
{
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 }));
  const parts = Array.from({ length: 30 }, (_, i) => ({ len: 10 + (i * 37) % 80 + 0.25 * (i % 4), qty: 1 + i % 5 }));
  const t0 = Date.now(); const r = K.solveBoards({ stock, parts }, { kerf: 0.125, trim: 0 }); const ms = Date.now() - t0;
  console.log(`  90 pieces → ${r.items.length} boards, $${r.cost.toFixed(2)} in ${ms} ms`);
  check(ms < 2000, 'big job took ' + ms + ' ms');
  check(r.items.reduce((a, b) => a + b.pieces.length, 0) === 90, 'big job lost pieces');
}

console.log('boards: hundreds of pieces in many lengths');
{
  // The exact search nests a call or more per board and length; this job used to run out of stack and stop the page.
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 }));
  const parts = Array.from({ length: 16 }, (_, i) => ({ len: 7 + i * 5.25, qty: 50 }));
  let r = null;
  try { r = K.solveBoards({ stock, parts }, { kerf: 0.125, trim: 0 }); } catch (e) { check(false, '16 lengths × 50 threw: ' + e.message); }
  if (r) check(r.items.reduce((a, b) => a + b.pieces.length, 0) === 800 && !r.errors.length, '16 lengths × 50: not every piece is planned');
}

console.log('sheets: two half sheets beat one full sheet');
{
  const stock = [{ len: 96, wid: 48, price: 58, have: 0 }, { len: 48, wid: 24, price: 24, have: 0 }];
  const parts = [{ len: 48, wid: 16, qty: 1, grain: true }, { len: 44.75, wid: 12.75, qty: 1, grain: true }];
  const r = K.solveSheets({ stock, parts }, { kerf: 0.125 });
  check(Math.abs(r.cost - 48) < 1e-6, `bench seat and shelf cost $${r.cost}, want $48 (two half sheets)`);
}

console.log('sheets: one on hand and more to buy');
{
  // "Have 1" on the 4×8 keeps a 4×8 to buy as well: six 72" sides need two sheets, one yours and one bought.
  const parts = [{ len: 72, wid: 11.25, qty: 6, grain: true }], ply = [{ len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  let r = K.solveSheets({ kind: 'sheet', stock: [{ len: 96, wid: 48, price: 58, have: 1 }, { len: 96, wid: 48, price: 58, have: 0 }, ...ply], parts }, { kerf: 0.125 });
  check(r.cost === 58 && r.items.length === 2 && r.items.filter(it => it.stock.have).length === 1 && !r.errors.length, `two sheets with one on hand: $${r.cost}, ${r.items.length} sheets, ${JSON.stringify(r.errors)}`);
  // With no 4×8 left to buy, the plan can't be made, and it says which part only the sheet on hand could hold.
  r = K.solveSheets({ kind: 'sheet', stock: [{ len: 96, wid: 48, price: 58, have: 1 }, ...ply], parts: [{ len: 20, wid: 10, qty: 2, grain: true }, ...parts] }, { kerf: 0.125 });
  check(r.items.length === 0 && r.errors.length === 1 && r.errors[0].pi === -1 && r.errors[0].only === 1, 'one 4×8 on hand for two sheets of sides: ' + JSON.stringify(r.errors));
}

console.log('sheets: more than 300 of one part');
{
  // Kerf packs at most 300 of a sheet part. The rest used to be left out without a word, so the plan under-bought.
  const r = K.solveSheets({ stock: [{ len: 96, wid: 48, price: 58, have: 0 }], parts: [{ len: 4, wid: 4, qty: 400, grain: false }] }, { kerf: 0.125 });
  check(r.items.reduce((a, s) => a + s.placed.length, 0) === 300, '400 pegs: placed ' + r.items.reduce((a, s) => a + s.placed.length, 0) + ', want 300');
  check(r.errors.length === 1 && r.errors[0].pi === 0 && r.errors[0].max === 300, '400 pegs: the plan doesn’t say it’s short: ' + JSON.stringify(r.errors.map(e => ({ pi: e.pi, max: e.max }))));
}

console.log('sheets: shuffling long enough to find the cheaper plan');
{
  // Two random ¾ plywood jobs, with full, half and quarter sheets for sale as the ¾ plywood preset has, that cost more
  // than the old 120 ms limit found on a laptop when the shuffle had half the work it has now: one bought a full
  // sheet where a half would do, the other an extra half sheet.
  const stock = [{ len: 96, wid: 48, price: 58, have: 0 }, { len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  const jobs = [
    [150, 174, [{ len: 22.25, wid: 13.25, qty: 8, grain: true }, { len: 19.5, wid: 28.875, qty: 5, grain: false }, { len: 26.75, wid: 25.375, qty: 6, grain: false }]],
    [290, 324, [{ len: 27.25, wid: 12.5, qty: 8, grain: true }, { len: 13, wid: 26.375, qty: 5, grain: false }, { len: 43.75, wid: 31.25, qty: 6, grain: true },
      { len: 25.25, wid: 27.25, qty: 4, grain: false }, { len: 42, wid: 27.875, qty: 2, grain: true }]],
  ];
  for (const [want, was, parts] of jobs) {
    const r = K.solveSheets({ stock, parts }, { kerf: 0.125 });
    check(Math.abs(r.cost - want) < 1e-6, `${parts.reduce((a, p) => a + p.qty, 0)} pieces of plywood cost $${r.cost}, want $${want} (half the shuffling bought $${was})`);
  }
}

console.log('sheets: random jobs, every layout checked');
{
  const R = rng(11), kerf = 0.125; let n = 0;
  for (let t = 0; t < 200; t++) {
    const parts = [];
    for (let k = 0, nT = 1 + Math.floor(R() * 6); k < nT; k++) parts.push({ len: Math.round((6 + R() * 60) * 4) / 4, wid: Math.round((4 + R() * 30) * 4) / 4, qty: 1 + Math.floor(R() * 5), grain: R() < 0.5 });
    const stock = [{ len: 96, wid: 48, price: 58, have: 0 }];
    if (t % 4 === 0) stock.push({ len: 48, wid: 24, price: 21, have: 0 });
    const r = K.solveSheets({ stock, parts }, { kerf });
    if (r.errors.length) continue;
    n++;
    let count = 0;
    r.items.forEach(sh => sh.placed.forEach((p, i) => {
      count++;
      const part = parts[p.pi];
      check(p.x > -1e-9 && p.y > -1e-9 && p.x + p.l <= sh.L + 1e-9 && p.y + p.w <= sh.W + 1e-9, `job ${t}: part off the sheet`);
      check(!(part.grain && p.rot), `job ${t}: a grain-locked part was turned`);
      const same = Math.abs(p.l - part.len) < 1e-9 && Math.abs(p.w - part.wid) < 1e-9, turned = Math.abs(p.l - part.wid) < 1e-9 && Math.abs(p.w - part.len) < 1e-9;
      check(same || (!part.grain && turned), `job ${t}: part placed at the wrong size`);
      sh.placed.forEach((q, j) => {
        if (j <= i) return;
        const apartX = p.x + p.l + kerf <= q.x + 1e-9 || q.x + q.l + kerf <= p.x + 1e-9;
        const apartY = p.y + p.w + kerf <= q.y + 1e-9 || q.y + q.w + kerf <= p.y + 1e-9;
        check(apartX || apartY, `job ${t}: parts overlap (kerf included)`);
      });
    }));
    check(count === parts.reduce((a, p) => a + p.qty, 0), `job ${t}: placed ${count} parts`);
    check(r.items.every(sh => sh.steps.every(s => s.type === 'none' || (s.at > 0 && (s.on === null || (s.on.w > 0 && s.on.h > 0))))), `job ${t}: a cut step is incomplete`);
  }
  console.log('  ' + n + ' jobs');
}

console.log('sheets: every part named by one step');
{
  // Each part on a sheet is named once at the saw: by the cut that gives it, by the cut that leaves it ("what's left
  // is"), or by the note that the whole sheet is that part. A part that needed no cut of its own used to take over the
  // name of whatever step came last, so the strip a rip cut off was never named, or named as the piece it left.
  const names = sh => [].concat(...sh.steps.map(s => (s.gives ? [s.gives] : []).concat(s.also || []))).map(g => g.it.pi + '@' + g.l + 'x' + g.w).sort();
  const parts = sh => sh.placed.map(p => p.pi + '@' + p.l + 'x' + p.w).sort();
  const full = [{ len: 96, wid: 48, price: 58, have: 0 }];
  const named = (what, stock, ps, kerf, want) => {
    const r = K.solveSheets({ stock, parts: ps }, { kerf });
    r.items.forEach((sh, si) => check(JSON.stringify(names(sh)) === JSON.stringify(parts(sh)), `${what}, sheet ${si + 1}: the steps name ${JSON.stringify(names(sh))}, its parts are ${JSON.stringify(parts(sh))}`));
    if (want) {
      const steps = r.items[0].steps.map(s => s.type + (s.at != null ? ' ' + s.at : '') + (s.gives ? ' → ' + s.gives.it.pi : '') + (s.also ? ' · left ' + s.also.map(g => g.it.pi).join(',') : ''));
      check(JSON.stringify(steps) === JSON.stringify(want), `${what}: steps ${JSON.stringify(steps)}, want ${JSON.stringify(want)}`);
    }
    return r;
  };
  // The sides of a cabinet, ripped from one sheet: the rip gives the 24" side and leaves the other.
  named('sides 96 × 24 and 96 × 23 7/8', full, [{ len: 96, wid: 24, qty: 1, grain: true }, { len: 96, wid: 23.875, qty: 1, grain: true }], 0.125, ['rip 24 → 0 · left 1']);
  named('two halves of a sheet, less the kerf', full, [{ len: 47.9375, wid: 48, qty: 2, grain: true }], 0.125, ['cross 47.9375 → 0 · left 0']);
  named('two rips of 23 15/16', full, [{ len: 96, wid: 23.9375, qty: 2, grain: true }], 0.125, ['rip 23.9375 → 0 · left 0']);
  named('a 20" crosscut and two 30 × 23 15/16', full, [{ len: 30, wid: 23.9375, qty: 2, grain: true }, { len: 20, wid: 48, qty: 1, grain: true }], 0.125);
  named('the whole sheet', full, [{ len: 96, wid: 48, qty: 1, grain: true }], 0.125, ['none → 0']);
  // Seeded jobs where parts often fill what a cut leaves exactly: halves, thirds and the rest of a sheet, kerf counted.
  const R = rng(23); let n = 0;
  for (let t = 0; t < 200; t++) {
    const kerf = [0.125, 0.09375, 0][t % 3], L = 96, W = 48, ps = [];
    const exact = [(W - kerf) / 2, (L - kerf) / 2, (W - 2 * kerf) / 3, (L - 2 * kerf) / 3, W, L];
    for (let k = 0, nT = 1 + Math.floor(R() * 4); k < nT; k++) {
      const a = R() < 0.5 ? exact[Math.floor(R() * exact.length)] : Math.round((4 + R() * 40) * 8) / 8;
      const b = R() < 0.5 ? exact[Math.floor(R() * exact.length)] : Math.round((4 + R() * 40) * 8) / 8;
      ps.push({ len: Math.max(a, b), wid: Math.min(a, b), qty: 1 + Math.floor(R() * 3), grain: R() < 0.5 });
    }
    // and now and then a part that fills the rest of a strip another part leaves
    if (R() < 0.5) { const w = Math.round((6 + R() * 30) * 8) / 8; ps.push({ len: L, wid: w, qty: 1, grain: true }, { len: L, wid: W - w - kerf, qty: 1, grain: true }); }
    const stock = t % 4 ? full : [{ len: 96, wid: 48, price: 58, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
    const r = named(`job ${t}`, stock, ps, kerf);
    if (!r.errors.length) n++;
  }
  console.log('  ' + n + ' jobs');
}

console.log('tips that are worth taking');
{
  const proj = (kind, stock, parts) => ({ name: 'T', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', materials: [{ id: 'm', kind, name: kind, note: '',
    stock: stock.map(([len, a, b], i) => kind === 'sheet' ? { id: 's' + i, len, wid: a, price: b, have: 0 } : { id: 's' + i, len, price: a, have: 0 }),
    parts: parts.map(([name, qty, len, wid, grain], i) => kind === 'sheet' ? { id: 'p' + i, name, qty, len, wid, grain: grain !== false } : { id: 'p' + i, name, qty, len }) }] });
  // What a tip promises against what using it does: the plan for the part at its new size, solved afresh.
  const applied = (p, t) => { const q = JSON.parse(JSON.stringify(p)); q.materials[0].parts.find(x => x.id === t.pid)[t.dim] = t.to; return tipper()(q).res.cost; };
  // The example's 2×4s: a rail at 47 15/16" fills an 8' board two at a time, $4.12 less.
  let p = proj('board', LUMBER, [['Leg', 4, 72], ['Front & back rail', 8, 48], ['Side rail', 8, 21]]), got = tipper()(p);
  check(got.tips.length === 1 && got.tips[0].pid === 'p1' && got.tips[0].to === 47.9375 && Math.abs(got.tips[0].save - 4.12) < 0.005, 'the example’s tip: ' + JSON.stringify(got.tips));
  // The workbench: 40 pieces in 11 lengths, too many for the exact search. Kerf's plan is $67.52, and the parts as they
  // are fit 14 8' boards and one 10' for $66.30, so shaving one never needed to promise $66.72.
  p = proj('board', LUMBER, [['Leg', 4, 33.25], ['Long apron', 2, 72], ['Short apron', 2, 24.25], ['Top frame long', 2, 72], ['Top frame short', 2, 27.25], ['Top joist', 8, 24.25],
    ['Shelf long', 2, 65], ['Shelf short', 4, 24.25], ['Shelf joist', 6, 24.25], ['Leg doubler', 4, 30.75], ['Brace', 4, 15.5]]);
  got = tipper()(p);
  const promised = got.tips.map(t => got.res.cost - t.save);
  check(promised.every(c => c < 66.30 - 0.005), `the workbench: a tip promises $${promised.map(c => c.toFixed(2)).join(', $')}, which the parts as they are can cost ($66.30)`);
  // Two 24" seats from the ¾ plywood sizes, free to turn: either one shaved a sixteenth fits a half sheet, $21 less. The
  // wide one said $8, what a quick solve found; using it saved $21.
  p = proj('sheet', [[96, 48, 58], [48, 48, 34], [48, 24, 21]], [['Seat', 2, 24, 24, false]]);
  got = tipper()(p);
  check(got.tips.length === 2, 'the seats: ' + got.tips.length + ' tips');
  for (const t of got.tips) check(Math.abs(t.save - (got.res.cost - applied(p, t))) < 0.005, `the seats: the ${t.dim} tip says $${t.save.toFixed(2)} less, using it saves $${(got.res.cost - applied(p, t)).toFixed(2)}`);
}

console.log('the same plan on a slow or busy device');
{
  // Each search stops after a fixed amount of work, not time, so a clock that crawls (as on a slow phone, or a busy
  // computer) changes nothing. With time limits, the example's 2×4s cost $43.94 instead of $42.64 when each look at
  // the clock took a millisecond, and the layout of a bigger sheet job changed with the speed of the machine.
  const plan = r => r.cost.toFixed(2) + ' ' + r.items.map(it => it.pieces
    ? it.stock.len + ':' + it.pieces.map(p => p.pi + '@' + p.len).join(',')
    : it.L + 'x' + it.W + ':' + it.placed.map(p => p.pi + '@' + p.x.toFixed(3) + ',' + p.y.toFixed(3) + (p.rot ? 'r' : '')).join(',')).join(' | ');
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 }));
  const sheets = [{ len: 96, wid: 48, price: 58, have: 0 }, { len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  const jobs = [
    ['the example 2×4s', () => K.solveBoards({ stock, parts: [{ len: 72, qty: 4 }, { len: 48, qty: 8 }, { len: 21, qty: 8 }] }, { kerf: 0.125, trim: 0 })],
    ['the example 2×4s, quick (for tips)', () => K.solveBoards({ stock, parts: [{ len: 72, qty: 4 }, { len: 47.9375, qty: 8 }, { len: 21, qty: 8 }] }, { kerf: 0.125, trim: 0 }, true)],
    ['14 lengths of 2×4', () => K.solveBoards({ stock, parts: Array.from({ length: 14 }, (_, i) => ({ len: 9.5 + i * 5.375, qty: 1 + i % 4 })) }, { kerf: 0.125, trim: 0 })],
    ['a plywood cabinet', () => K.solveSheets({ stock: sheets, parts: [{ len: 34.5, wid: 23.25, qty: 4, grain: true }, { len: 30, wid: 23.25, qty: 2, grain: true }, { len: 30, wid: 4, qty: 4 },
      { len: 28.5, wid: 11.25, qty: 6, grain: true }, { len: 33, wid: 15.75, qty: 2, grain: true }, { len: 15, wid: 6, qty: 8 }] }, { kerf: 0.125 })],
  ];
  const realNow = Date.now;
  for (const [what, solve] of jobs) {
    const usual = plan(solve());
    let t = realNow(), slow;
    Date.now = () => (t += 1);
    try { slow = plan(solve()); } finally { Date.now = realNow; }
    check(slow === usual, `${what}: a slow clock changed the plan\n    usual ${usual.slice(0, 120)}\n    slow  ${slow.slice(0, 120)}`);
    if (what === 'the example 2×4s') check(slow.startsWith('42.64 '), `the example 2×4s cost $${slow.split(' ')[0]} with a slow clock, want $42.64`);
  }
}

console.log('plans kept between edits');
{
  // Kerf keeps each material's plan until something it's worked out from changes. In a project with a board and a
  // sheet material, each edit below plans again only the materials listed, and what the page has is the plan a fresh
  // start finds (every search does a set amount of work, so it's the same plan), pointing at the project's own sizes
  // and parts. The edits follow on from each other, so a plan is kept across several.
  const page = planner(), fresh = planner();
  const p = { name: 'Garage shelves', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', materials: [
    { id: 'studs', kind: 'board', name: '2×4', note: '1½ × 3½ in', stock: LUMBER.map((s, i) => ({ id: 'b' + i, len: s[0], price: s[1], have: 0 })),
      parts: [{ id: 'leg', name: 'Leg', qty: 4, len: 72 }, { id: 'rail', name: 'Rail', qty: 8, len: 48 }, { id: 'beam', name: 'Beam', qty: 1, len: 200 }] },
    { id: 'ply', kind: 'sheet', name: '¾ plywood', note: '23/32 in actual', stock: [{ id: 's0', len: 96, wid: 48, price: 58, have: 0 }, { id: 's1', len: 48, wid: 24, price: 21, have: 0 }],
      parts: [{ id: 'shelf', name: 'Shelf', qty: 4, len: 47.75, wid: 23.75, grain: true }, { id: 'top', name: 'Top', qty: 1, len: 100, wid: 30, grain: true }] },
  ] };
  const [studs, ply] = p.materials;
  // What the page shows from a plan, and whether it points at this project's own material, sizes and parts.
  const own = (yes, id) => (yes ? id : 'another copy of ' + id);
  const shown = (res, proj) => JSON.stringify([res.cost, res.boards, res.sheets, res.cuts, res.boardYield, res.boardKerf, res.sheetYield, res.mats.map((r, mi) => {
    const m = proj.materials[mi];
    return [own(r.mat === m, m.id), r.cost, r.exact, r.run, r.errors.map(e => [e.pi, e.max, e.only, e.pi < 0 || own(e.part === m.parts[e.pi], m.parts[e.pi].id)]),
      r.items.map(it => [own(m.stock.includes(it.stock), it.stock.id), it.price, it.cap, it.trim, it.need, it.offcut, it.pieces, it.L, it.W, it.placed, it.spare,
        it.steps && it.steps.map(s => [s.type, s.at, s.on, s.line, s.gives && [s.gives.it.pi, s.gives.l, s.gives.w, s.gives.rot]])])];
  })]);
  const edits = [
    ['opening the project', () => {}, ['studs', 'ply']],
    ['renaming a sheet part', () => { ply.parts[0].name = 'Adjustable shelf'; }, []],
    ['renaming a board part', () => { studs.parts[0].name = 'Long leg'; }, []],
    ['renaming a part too big for any size', () => { ply.parts[1].name = 'Bench top'; studs.parts[2].name = 'Ridge beam'; }, []],
    ['renaming the materials, and a note', () => { studs.name = 'Stud'; ply.name = 'Birch ply'; ply.note = 'from the yard'; }, []],
    ['the project’s name, currency and offcuts worth keeping', () => { p.name = 'Shed shelves'; p.cur = '€'; p.keep = 18; }, []],
    ['a sheet part’s count', () => { ply.parts[0].qty = 6; }, ['ply']],
    ['a sheet part’s width', () => { ply.parts[0].wid = 22; }, ['ply']],
    ['a sheet part’s grain', () => { ply.parts[0].grain = false; }, ['ply']],
    ['a sheet part’s length', () => { ply.parts[0].len = 46; }, ['ply']],
    ['a board part’s length', () => { studs.parts[0].len = 70.5; }, ['studs']],
    ['a board part’s count', () => { studs.parts[1].qty = 6; }, ['studs']],
    ['a board size’s price', () => { studs.stock[0].price = 4.5; }, ['studs']],
    ['three of a board size on hand', () => { studs.stock[1].have = 3; }, ['studs']],
    ['buying that size again', () => { studs.stock[1].have = 0; }, ['studs']],
    ['a sheet size’s price', () => { ply.stock[0].price = 61; }, ['ply']],
    ['a sheet size’s width', () => { ply.stock[1].wid = 30; }, ['ply']],
    ['a sheet size’s length', () => { ply.stock[1].len = 60; }, ['ply']],
    ['a sheet on hand', () => { ply.stock[0].have = 1; }, ['ply']],
    ['buying that sheet again', () => { ply.stock[0].have = 0; }, ['ply']],
    ['a board size’s length', () => { studs.stock[3].len = 180; }, ['studs']],
    ['an offcut on hand', () => { studs.stock.push({ id: 'b4', len: 40, price: 0, have: 2 }); }, ['studs']],
    ['a sheet size taken away', () => { ply.stock.pop(); }, ['ply']],
    ['the kerf', () => { p.kerf = 0.09375; }, ['studs', 'ply']],
    ['trimming each board end', () => { p.trim = 0.25; }, ['studs']],
    ['millimetres, which a sheet’s steps are written in', () => { p.units = 'mm'; }, ['ply']],
    ['back to inches', () => { p.units = 'in'; }, ['ply']],
    ['a new part with no length yet', () => { studs.parts.push({ id: 'cleat', name: '', qty: 1, len: 0 }); }, []],
    ['its name and count', () => { studs.parts[3].name = 'Cleat'; studs.parts[3].qty = 3; }, []],
    ['its length', () => { studs.parts[3].len = 30; }, ['studs']],
    ['a sheet part taken away', () => { ply.parts.pop(); }, ['ply']],
    // A part's place in the list is how the plan finds its letter and name, so a part that moves up plans again.
    ['an empty board part, and another after it', () => { studs.parts.push({ id: 'gap', name: '', qty: 1, len: 0 }, { id: 'brace', name: 'Brace', qty: 2, len: 20 }); }, ['studs']],
    ['the empty board part taken away', () => { studs.parts.splice(4, 1); }, ['studs']],
    ['an empty sheet part, and another after it', () => { ply.parts.push({ id: 'gap2', name: '', qty: 1, len: 0, wid: 0, grain: true }, { id: 'back', name: 'Back', qty: 1, len: 30, wid: 20, grain: true }); }, ['ply']],
    ['the empty sheet part taken away', () => { ply.parts.splice(1, 1); }, ['ply']],
  ];
  let proj = p;
  const run = (what, want) => {
    const got = page.solve(proj);
    check(JSON.stringify(got.planned) === JSON.stringify(want), `${what} planned ${JSON.stringify(got.planned)}, want ${JSON.stringify(want)}`);
    const copy = JSON.parse(JSON.stringify(proj));
    fresh.forget();
    const plan = shown(got.res, proj), anew = shown(fresh.solve(copy).res, copy);
    check(plan === anew, `after ${what}, the page’s plan isn’t the one a fresh start finds\n    kept  ${plan.slice(0, 160)}\n    fresh ${anew.slice(0, 160)}`);
    return got.res;
  };
  for (const [what, edit, want] of edits) { edit(); run(what, want); }
  // Another window's save brings a new copy of the whole project: nothing is planned, and the plan points at the copy.
  proj = JSON.parse(JSON.stringify(p));
  const res = run('another window’s copy of the project', []);
  // A size the plan uses, taken away there and put back the same but under a new id: the plan points at the new one.
  const used = proj.materials.map((m, mi) => m.stock.findIndex(s => s.id === res.mats[mi].items[0].stock.id));
  proj = JSON.parse(JSON.stringify(proj));
  proj.materials.forEach((m, mi) => { m.stock[used[mi]].id += ' again'; });
  run('another window’s copy with a size put back', []);
}

console.log('ticks stay on their cuts');
{
  // Ticks at the saw are kept per material, under a key made of what each of its cuts is. Wherever an edit keeps a
  // material's key, its ticks stay put, so every cut the saw shows for it must read exactly as before (part names
  // aside: renaming a part keeps its ticks). Seeded random edits to a project with a board and a sheet material.
  const saw = () => new Function([
    ...SOLVER, 'var P = null, RES = null, CUR = "$";', line('var PLANS = '),
    ...['plural', 'sayLen', 'lastIsLeft', 'cfg', 'solveMat', 'planInputs', 'solveAll', 'letter', 'pieceName', 'stepGives', 'sawTasks', 'tickKeys'].map(fn),
    'return { solve: function (p) { P = p; U = p.units; solveAll(); var t = sawTasks(); return { keys: tickKeys(t), tasks: t }; } };'
  ].join('\n'))();
  const R = rng(11), pick = a => a[Math.floor(R() * a.length)], q16 = x => Math.round(x * 16) / 16;
  let ids = 0; const id = () => 'x' + ids++;
  // What the saw shows for each material's cuts, with every part's name left out.
  const text = (page, p) => {
    const names = p.materials.map(m => m.parts.map(q => q.name));
    p.materials.forEach(m => m.parts.forEach(q => { q.name = ''; }));
    const out = {};
    try { page.solve(p).tasks.forEach(t => { (out[t.mid] = out[t.mid] || []).push(t.title + ': ' + t.cuts.map(c => c.noCut ? c.note : c.meas + ' ' + c.what + ' / ' + c.sub).join(' ; ')); }); }
    finally { p.materials.forEach((m, mi) => m.parts.forEach((q, k) => { q.name = names[mi][k]; })); }
    return out;
  };
  let kept = 0, changed = 0, drift = 0;
  for (let seq = 0; seq < 10; seq++) {
    const page = saw();
    const studs = { id: 'studs', kind: 'board', name: '2×4', note: '', stock: LUMBER.map(st => ({ id: id(), len: st[0], price: st[1], have: 0 })), parts: [] };
    const ply = { id: 'ply', kind: 'sheet', name: '¾ ply', note: '', stock: [{ id: id(), len: 96, wid: 48, price: 58, have: 0 }, { id: id(), len: 48, wid: 24, price: 21, have: 0 }], parts: [] };
    for (let k = 0; k < 3; k++) studs.parts.push({ id: id(), name: 'B' + k, qty: 1 + Math.floor(R() * 4), len: q16(10 + R() * 70) });
    for (let k = 0; k < 3; k++) ply.parts.push({ id: id(), name: 'S' + k, qty: 1 + Math.floor(R() * 2), len: q16(8 + R() * 30), wid: q16(6 + R() * 16), grain: R() < 0.5 });
    const p = { name: 'P', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', materials: [studs, ply] };
    let keys = page.solve(p).keys, shown = text(page, p);
    for (let e = 0; e < 40; e++) {
      const m = pick(p.materials), sheet = m.kind === 'sheet', q = m.parts.length ? pick(m.parts) : null;
      const [what, edit] = pick([
        ['a new part', () => m.parts.push(sheet ? { id: id(), name: 'n', qty: 1, len: q16(5 + R() * 30), wid: q16(4 + R() * 16), grain: true } : { id: id(), name: 'n', qty: 1, len: q16(5 + R() * 60) })],
        ['a part taken away', () => m.parts.length > 1 && m.parts.splice(m.parts.indexOf(q), 1)],
        ['a part moved', () => { if (m.parts.length > 1) { m.parts.splice(m.parts.indexOf(q), 1); m.parts.splice(Math.floor(R() * (m.parts.length + 1)), 0, q); } }],
        ['a count', () => q && (q.qty = Math.floor(R() * 4))],
        ['a length', () => q && (q.len = q16(R() < 0.1 ? 0 : 5 + R() * (sheet ? 40 : 60)))],
        ['a length resized where it sits', () => q && (q.len = q16(q.len + (R() < 0.5 ? -1 : 1) * (1 + Math.floor(R() * 8))))],
        ['a width', () => q && sheet && (q.wid = q16(4 + R() * 20))],
        ['a name', () => q && (q.name = 'r' + Math.floor(R() * 99))],
        ['grain', () => q && sheet && (q.grain = !q.grain)],
        ['the kerf', () => (p.kerf = pick([0.125, 0.09375, 0.1875]))],
        ['trim', () => (p.trim = pick([0, 0, 0.25, 0.5]))],
        ['a price', () => (pick(m.stock).price = Math.round(R() * 6000) / 100)],
        ['a size on hand', () => (pick(m.stock).have = pick([0, 0, 1, 2]))],
        ['a size’s length', () => { const st = pick(m.stock); st.len = q16(st.len + pick([-6, -1, 1, 6])); }],
        ['offcuts worth keeping', () => (p.keep = pick([6, 12, 18, 24]))],
      ]);
      edit();
      const keys2 = page.solve(p).keys, shown2 = text(page, p);
      for (const mid of Object.keys(keys2)) {
        if (keys2[mid] !== keys[mid]) { changed++; continue; }
        kept++;
        const a = JSON.stringify(shown[mid] || []), b = JSON.stringify(shown2[mid] || []);
        if (a !== b && drift++ < 3) check(false, `${what} kept the ${mid} tick key, but a cut at the saw changed:\n    before ${a.slice(0, 200)}\n    after  ${b.slice(0, 200)}`);
      }
      keys = keys2; shown = shown2;
    }
  }
  check(drift === 0, `${drift} edits kept a tick key while a cut changed`);
  check(kept > 200 && changed > 100, `too few edits kept (${kept}) or changed (${changed}) a tick key to tell`);
  console.log(`  ${kept} times a material's tick key was kept, ${changed} times it changed`);
  // A cut is the same cut whatever the units: switching to millimetres plans the sheets again, the same, and keeps both keys.
  {
    const page = saw();
    const p = { name: 'P', units: 'in', kerf: 0.125, trim: 0.25, keep: 12, cur: '$', materials: [
      { id: 'b', kind: 'board', name: '2×4', note: '', stock: [{ id: 's', len: 96, price: 4, have: 0 }], parts: [{ id: 'l', name: 'Leg', qty: 3, len: 30 }] },
      { id: 'p', kind: 'sheet', name: 'ply', note: '', stock: [{ id: 't', len: 96, wid: 48, price: 58, have: 0 }], parts: [{ id: 'h', name: 'Shelf', qty: 3, len: 30, wid: 20, grain: true }] }] };
    const inches = page.solve(p).keys; p.units = 'mm';
    check(JSON.stringify(page.solve(p).keys) === JSON.stringify(inches), 'switching to millimetres changed a tick key');
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
