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
  ...['esc', 'sixteenths', 'mmOf', 'fmt', 'frac', 'fmtH', 'parseLen', 'mulberry', 'bestFill', 'onlyHave', 'planWhatFits', 'solveBoards', 'orientations', 'newSheet',
    'placeIn', 'fitsStock', 'packRun', 'stripSheet', 'stripRun', 'sawScore', 'orderSteps', 'freeArea', 'evalSheets', 'sheetSteps', 'solveSheets', 'ripped', 'solveRip'].map(fn),
];
const K = new Function([
  ...SOLVER,
  'return { parseLen: parseLen, fmt: fmt, fmtH: fmtH, solveBoards: solveBoards, solveSheets: solveSheets, ripped: ripped, solveRip: solveRip, units: function (u) { U = u; } };'
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
// [units, text, inches]. A comma before three digits is a thousands comma; before one or two, a decimal point.
const LENGTHS = [
  ...Object.entries({ '35 3/4': 35.75, '35-3/4': 35.75, '2\' 11 3/4"': 35.75, '8\'': 96, '8 ft': 96, '3/4': 0.75, '¾': 0.75, '1½"': 1.5, '910mm': 910 / 25.4, '2.4 m': 2400 / 25.4,
    '35,75': 35.75, '2,4 m': 2400 / 25.4, '1,220 mm': 1220 / 25.4, 'abc': NaN, '1/0': NaN }).map(([s, x]) => ['in', s, x]),
  ...Object.entries({ '600': 600, '2,440': 2440, '1,220 mm': 1220, '2,440mm': 2440, '2,5': 2.5, '2,5 mm': 2.5, '12,25': 12.25, '1,000,000': 1e6, '2,44 m': 2440, '2,4400': 2.44, ',440': 0.44 })
    .map(([s, mm]) => ['mm', s, mm / 25.4]),
];
for (const [u, s, want] of LENGTHS) {
  K.units(u); const got = K.parseLen(s); K.units('in');
  check(Number.isNaN(want) ? Number.isNaN(got) : Math.abs(got - want) < 1e-9, `parseLen(${JSON.stringify(s)}) in ${u} = ${got}, want ${want}`);
}
// The kerf-planner skill's make_kerf.py reads lengths with a copy of parseLen in Python: the same text, the same inches.
{
  const code = 'import sys, json; sys.path.insert(0, sys.argv[1]); import make_kerf as m; print(json.dumps([m.parse_len(s, u) for u, s in json.loads(sys.argv[2])]))';
  const run = require('child_process').spawnSync('python3', ['-I', '-B', '-c', code, path.join(__dirname, '..', 'skill', 'kerf-planner', 'scripts'), JSON.stringify(LENGTHS.map(([u, s]) => [u, s]))], { encoding: 'utf8' });
  if (run.error && run.error.code === 'ENOENT') console.log('  (no python3 here, so make_kerf.py’s lengths were not checked)');
  else {
    check(run.status === 0, 'make_kerf.py’s parse_len didn’t run: ' + run.stderr);
    const got = run.status === 0 ? JSON.parse(run.stdout) : [];
    LENGTHS.forEach(([u, s, want], i) => {
      const py = got[i] == null ? NaN : got[i];
      check(Number.isNaN(want) ? Number.isNaN(py) : Math.abs(py - want) < 1e-9, `make_kerf.py reads ${JSON.stringify(s)} in ${u} as ${py} inches, Kerf as ${want}`);
    });
  }
}
check(K.fmt(35.75) === '35 3/4"' && K.fmt(96, { ft: true }) === "8'" && K.fmt(102.5, { ft: true }) === "8' 6 1/2\"", 'fmt in inches');
// Just under a whole foot rounds up to it, not to 12": 2438 mm is 8', not 7' 12".
for (const [x, want, wantH] of [[95.98, "8'", '8′'], [2438 / 25.4, "8'", '8′'], [107.97, "9'", '9′'], [191.975, "16'", '16′'], [95.96, "7' 11 15/16\"", '7′ 11 <span class="fr"><span class="sr">15/16</span><span aria-hidden="true"><sup>15</sup>⁄<sub>16</sub></span></span>″']]) {
  const got = K.fmt(x, { ft: true }), gotH = K.fmtH(x, { ft: true });
  check(got === want && gotH === wantH, `fmt(${x}, in feet) = ${got} and ${gotH}, want ${want}`);
}
K.units('mm'); check(K.parseLen('600') === 600 / 25.4 && K.fmt(600 / 25.4) === '600 mm', 'millimeters'); K.units('in');
// Fine, for a field and the kerf: to the 32nd, or the tenth of a millimetre, so what was typed reads back as typed.
for (const [u, x, o, want] of [['in', 3 / 32, {}, '1/8"'], ['in', 3 / 32, { fine: true }, '3/32"'], ['in', 23 + 3 / 32, { fine: true }, '23 3/32"'], ['in', 23.125, { fine: true }, '23 1/8"'],
  ['in', 96 + 3 / 32, { ft: true, fine: true }, "8' 3/32\""], ['in', 191.99, { ft: true, fine: true }, "16'"], ['mm', 2.2 / 25.4, {}, '2 mm'], ['mm', 2.2 / 25.4, { fine: true }, '2.2 mm'],
  ['mm', 3 / 25.4, { fine: true }, '3 mm'], ['mm', 603.3 / 25.4, { fine: true, bare: true }, '603.3'], ['mm', 2440 / 25.4, { fine: true, ft: true }, '2440 mm']]) {
  K.units(u); const got = K.fmt(x, o); K.units('in');
  check(got === want, `fmt(${x}, ${JSON.stringify(o)}) in ${u} = ${got}, want ${want}`);
}

console.log('boards: the example project');
{
  const stock = LUMBER.map(s => ({ len: s[0], price: s[1], have: 0 }));
  const r = K.solveBoards({ stock, parts: [{ len: 72, qty: 4 }, { len: 48, qty: 8 }, { len: 21, qty: 8 }] }, { kerf: 0.125, trim: 0 });
  check(Math.abs(r.cost - 42.64) < 1e-6, `garage shelves 2×4s cost $${r.cost.toFixed(2)}, want $42.64`);
}

const errs = r => JSON.stringify(r.errors.map(e => ({ pi: e.pi, short: e.short, only: e.only })));
console.log('boards: on-hand boards that run short');
{
  // Only two boards on hand and nothing to buy: three legs can't all be cut. The plan cuts the two that fit and says the
  // third is left out, rather than planning nothing.
  let r = null;
  try { r = K.solveBoards({ stock: [{ len: 96, price: 0, have: 2 }], parts: [{ len: 72, qty: 3 }] }, { kerf: 0.125, trim: 0 }); } catch (e) { check(false, 'have 2 for 3 legs threw: ' + e.message); }
  if (r) check(r.items.length === 2 && r.cost === 0 && r.errors.length === 1 && r.errors[0].pi === 0 && r.errors[0].short === 1 && !r.exact, 'have 2 for 3 legs: ' + r.items.length + ' boards, ' + errs(r));
  r = K.solveBoards({ stock: [{ len: 96, price: 0, have: 3 }], parts: [{ len: 72, qty: 3 }] }, { kerf: 0.125, trim: 0 });
  check(r.items.length === 3 && r.cost === 0 && !r.errors.length, 'have 3 for 3 legs uses all three, free');
  // An 8' board on hand and 4' boards to buy: one 72" leg fits only the board on hand, the other is left out, and the
  // rails that fit a 4' board are all bought and planned. A 120" beam fits nothing at all.
  const stock = [{ len: 96, price: 0, have: 1 }, { len: 48, price: 2.5, have: 0 }];
  r = K.solveBoards({ stock, parts: [{ len: 120, qty: 1 }, { len: 30, qty: 4 }, { len: 72, qty: 2 }] }, { kerf: 0.125, trim: 0 });
  const got = {}; r.items.forEach(b => b.pieces.forEach(p => { got[p.pi] = (got[p.pi] || 0) + 1; }));
  check(got[1] === 4 && got[2] === 1 && !got[0] && r.cost === 10 && errs(r) === '[{"pi":0},{"pi":2,"short":1}]', 'a leg short with rails to buy: ' + JSON.stringify(got) + ' $' + r.cost + ' ' + errs(r));
}

console.log('on-hand stock that runs short, with nothing to buy for some parts: what fits is planned');
{
  // Seeded jobs where some parts fit only the boards or sheets on hand, and those run out. Every part is planned or
  // said to be left out, never both and never more than asked for; only parts no size to buy can hold are left out;
  // nothing uses more on hand than there is; no part left out fits in the room the plan leaves; and the same parts less
  // those left out come out as planned.
  const R = rng(4711); let shortJobs = 0;
  for (let t = 0; t < 160; t++) {
    const sheet = t % 2 === 1, kerf = 0.125;
    let stock, parts;
    if (!sheet) {
      stock = [{ len: 96, price: 0, have: 1 + Math.floor(R() * 3) }, { len: 72, price: 0, have: Math.floor(R() * 2) }];
      if (t % 4 === 0) stock.push({ len: 48, price: 3, have: 0 });
      parts = Array.from({ length: 1 + Math.floor(R() * 4) }, () => ({ len: Math.round((10 + R() * 80) * 8) / 8, qty: 1 + Math.floor(R() * 4) }));
    } else {
      stock = [{ len: 96, wid: 48, price: 0, have: 1 + Math.floor(R() * 2) }];
      if (t % 4 === 1) stock.push({ len: 48, wid: 24, price: 21, have: 0 });
      parts = Array.from({ length: 1 + Math.floor(R() * 4) }, () => ({ len: Math.round((8 + R() * 80) * 4) / 4, wid: Math.round((4 + R() * 30) * 4) / 4, qty: 1 + Math.floor(R() * 4), grain: R() < 0.6 }));
    }
    const mat = { kind: sheet ? 'sheet' : 'board', stock, parts };
    const r = sheet ? K.solveSheets(mat, { kerf }) : K.solveBoards(mat, { kerf, trim: 0 });
    const got = parts.map(() => 0), used = new Map();
    r.items.forEach(it => { (sheet ? it.placed : it.pieces).forEach(p => got[p.pi]++); used.set(it.stock, (used.get(it.stock) || 0) + 1); });
    const short = parts.map(() => 0); r.errors.forEach(e => { if (e.short) short[e.pi] += e.short; });
    if (short.some(n => n)) shortJobs++;
    check(!r.errors.some(e => e.pi < 0), `job ${t}: planned nothing: ${errs(r)}`);
    parts.forEach((p, pi) => {
      const big = r.errors.some(e => e.pi === pi && !e.short && !e.max);
      check(big ? got[pi] === 0 && !short[pi] : got[pi] + short[pi] === p.qty, `job ${t}: part ${pi} × ${p.qty}: ${got[pi]} planned, ${short[pi]} left out${big ? ', and too big' : ''}`);
      const buyable = stock.some(s => !s.have && (sheet ? (p.len <= s.len && p.wid <= s.wid) || (!p.grain && p.len <= s.wid && p.wid <= s.len) : p.len <= s.len));
      check(!short[pi] || !buyable, `job ${t}: part ${pi} left out though a size to buy holds it`);
    });
    check(stock.every(s => !s.have || (used.get(s) || 0) <= s.have), `job ${t}: used more on hand than there is`);
    // and no part left out would fit in the room the plan leaves on a board, or on a piece left over from a sheet
    const fits = (p, f) => (p.len <= f.w + 1e-9 && p.wid <= f.h + 1e-9) || (!p.grain && p.wid <= f.w + 1e-9 && p.len <= f.h + 1e-9);
    check(!parts.some((p, pi) => short[pi] && r.items.some(it => sheet ? it.spare.some(f => fits(p, f)) : it.cap - it.need >= kerf + p.len - 1e-9)), `job ${t}: a part left out fits in the room left`);
    if (short.some(n => n)) {
      const again = { kind: mat.kind, stock, parts: parts.map((p, pi) => ({ ...p, qty: got[pi] })) };
      const r2 = sheet ? K.solveSheets(again, { kerf }) : K.solveBoards(again, { kerf, trim: 0 });
      check(!r2.errors.length && Math.abs(r2.cost - r.cost) < 1e-6 && r2.items.length === r.items.length, `job ${t}: the parts that fit, planned again, come out differently`);
    }
  }
  check(shortJobs > 40, 'only ' + shortJobs + ' of the jobs leave parts out');
  console.log('  ' + shortJobs + ' jobs leave parts out');
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

console.log('sheets: a sheet’s length is the way its grain runs');
{
  // A sheet's Length is the way its grain runs, as a part's is: a sheet typed 48" long and 96" wide has its grain
  // across the 96" side. Kerf used to take the longer side as the grain whatever was typed, so a grain-locked 90" part
  // planned on it with its grain across the sheet's.
  const crossGrain = [{ len: 48, wid: 96, price: 58, have: 0 }];
  let r = K.solveSheets({ stock: crossGrain, parts: [{ len: 90, wid: 20, qty: 1, grain: true }] }, { kerf: 0.125 });
  check(r.errors.length === 1 && r.errors[0].pi === 0 && !r.items.length, 'a grain-locked 90" part on a sheet 48" along the grain: ' + JSON.stringify(r.errors.map(e => e.pi)));
  r = K.solveSheets({ stock: crossGrain, parts: [{ len: 40, wid: 90, qty: 1, grain: true }] }, { kerf: 0.125 });
  check(!r.errors.length && r.items.length === 1 && r.items[0].L === 48 && r.items[0].W === 96 && !r.items[0].placed[0].rot, 'a 40" × 90" part along that sheet’s grain: ' + JSON.stringify(r.items.map(it => [it.L, it.W])));
  // A part free to turn still fits either way.
  r = K.solveSheets({ stock: crossGrain, parts: [{ len: 90, wid: 20, qty: 1, grain: false }] }, { kerf: 0.125 });
  check(!r.errors.length && r.items[0].placed[0].rot, 'a 90" part free to turn on that sheet');
}

console.log('sheets: of plans that cost the same, the one kinder to a table saw');
{
  // Among layouts that cost the same, Kerf takes one that starts by ripping the sheet rather than crosscutting a whole
  // 4×8, with as few fence settings as it can. The example's four shelves started with a crosscut across the sheet and
  // took 7 cuts; two cabinet sides did too, then ripped each half.
  const full = [{ len: 96, wid: 48, price: 58, have: 0 }], ply = [...full, { len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  const steps = r => r.items.map(sh => sh.steps.map(s => s.type + ' ' + s.at + (s.on ? '' : ' (sheet)')));
  const jobs = [
    ['the example’s shelves', ply, [{ len: 47.75, wid: 23.75, qty: 4, grain: true }], 6],
    ['two cabinet sides', full, [{ len: 30.25, wid: 23.75, qty: 2, grain: true }], 3],
    ['six 30 × 12 shelves', full, [{ len: 30, wid: 12, qty: 6, grain: true }], 8],
  ];
  for (const [what, stock, parts, cuts] of jobs) {
    const r = K.solveSheets({ stock, parts }, { kerf: 0.125 }), s = steps(r)[0];
    const rips = new Set(s.filter(x => x.startsWith('rip')).map(x => x.split(' ')[1]));
    check(r.items.length === 1 && s[0].startsWith('rip ') && s[0].endsWith('(sheet)') && rips.size === 1 && s.length === cuts, `${what}: ${JSON.stringify(s)}, want a rip of the full sheet first, one fence setting and ${cuts} cuts`);
  }
}

console.log('sheets: cuts in the order to make them');
{
  // A sheet's cuts come in the order to make them: each once the piece it's made on exists, cuts at the same fence
  // setting (or crosscuts at the same length) one after another, and otherwise the piece in your hands finished first.
  // Six 30 × 12 shelves used to rip a 12" strip, crosscut it, then set the fence at 12" again for the second strip.
  const full = [{ len: 96, wid: 48, price: 58, have: 0 }];
  const order = parts => K.solveSheets({ stock: full, parts }, { kerf: 0.125 }).items[0].steps.map(s => s.type + ' ' + s.at);
  let got = order([{ len: 30, wid: 12, qty: 6, grain: true }]);
  check(JSON.stringify(got) === JSON.stringify(['rip 12', 'rip 12', ...Array(6).fill('cross 30')]), 'six 30 × 12 shelves: ' + JSON.stringify(got));
  got = order([{ len: 47.75, wid: 23.75, qty: 4, grain: true }]);
  check(JSON.stringify(got) === JSON.stringify(['rip 23.75', 'rip 23.75', ...Array(4).fill('cross 47.75')]), 'the example’s shelves: ' + JSON.stringify(got));
  // In seeded jobs, every cut is made on a piece an earlier cut made (or the full sheet), and the cuts at one setting
  // come together wherever the pieces allow: no cut is followed by one at another setting while a cut at its own
  // setting was ready to make.
  const R = rng(91); let n = 0;
  for (let t = 0; t < 150; t++) {
    const ps = [];
    for (let k = 0, nT = 1 + Math.floor(R() * 5); k < nT; k++) ps.push({ len: Math.round((6 + R() * 50) * 4) / 4, wid: Math.round((3 + R() * 24) * 4) / 4, qty: 1 + Math.floor(R() * 5), grain: R() < 0.6 });
    const r = K.solveSheets({ stock: full, parts: ps }, { kerf: 0.125 });
    r.items.forEach((sh, si) => {
      // replay the cuts: each splits the piece its line crosses edge to edge
      let pieces = [{ x: 0, y: 0, w: sh.L, h: sh.W }];
      // a cut is ready once there's a piece of the size it names that its line crosses edge to edge
      const ready = st => {
        const [x1, y1, x2, y2] = st.line, rip = st.type === 'rip', of = st.of === 'sheet' ? [sh.L, sh.W] : st.of.split(' ')[1].split('×').map(Number);
        return pieces.findIndex(p => Math.abs(p.w - of[0]) < 1e-3 && Math.abs(p.h - of[1]) < 1e-3 && (rip ? Math.abs(p.x - x1) < 1e-6 && Math.abs(p.x + p.w - x2) < 1e-6 && y1 > p.y + 1e-6 && y1 < p.y + p.h - 1e-6
          : Math.abs(p.y - y1) < 1e-6 && Math.abs(p.y + p.h - y2) < 1e-6 && x1 > p.x + 1e-6 && x1 < p.x + p.w - 1e-6));
      };
      const cuts = sh.steps.filter(s => s.type !== 'none');
      cuts.forEach((st, k) => {
        const i = ready(st);
        check(i >= 0, `order job ${t}, sheet ${si + 1}: cut ${k + 1} (${st.type} at ${st.at}) comes before the piece it's made on`);
        if (i < 0) return;
        const p = pieces[i], [x1, y1] = st.line;
        pieces.splice(i, 1, ...(st.type === 'rip' ? [{ x: p.x, y: p.y, w: p.w, h: y1 - p.y }, { x: p.x, y: y1 + 0.125, w: p.w, h: p.y + p.h - y1 - 0.125 }] : [{ x: p.x, y: p.y, w: x1 - p.x, h: p.h }, { x: x1 + 0.125, y: p.y, w: p.x + p.w - x1 - 0.125, h: p.h }]));
        const next = cuts[k + 1], same = c => c.type === st.type && Math.abs(c.at - st.at) < 1e-9;
        if (next && !same(next)) check(!cuts.slice(k + 1).some(c => same(c) && ready(c) >= 0), `order job ${t}, sheet ${si + 1}: after cut ${k + 1} (${st.type} at ${st.at}) another at that setting was ready, but cut ${k + 2} is ${next.type} at ${next.at}`);
      });
      n++;
    });
  }
  console.log('  ' + n + ' sheets');
}

console.log('sheets: trimming the factory edges');
{
  // Trim sheet edges plans each sheet that much smaller each way, inside the trimmed edges of the full sheet. Two 96"
  // sides no longer fit once 1/4" comes off each end, and the example's shelves, which fill a 4×8 with 1/4" to spare
  // each way, fit with 1/8" trimmed off each edge; with 1/4" no two fit side by side either way, so each takes a 4×8.
  const full = [{ len: 96, wid: 48, price: 58, have: 0 }], ply = [...full, { len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  let r = K.solveSheets({ stock: full, parts: [{ len: 96, wid: 23.9375, qty: 2, grain: true }] }, { kerf: 0.125, edge: 0.25 });
  check(r.errors.length === 1 && r.errors[0].pi === 0, 'two 96" sides with 1/4" off each edge: ' + JSON.stringify(r.errors));
  const shelves = [{ len: 47.75, wid: 23.75, qty: 4, grain: true }];
  for (const [edge, cost] of [[0, 58], [0.125, 58], [0.25, 232]]) {
    r = K.solveSheets({ stock: ply, parts: shelves }, { kerf: 0.125, edge });
    check(Math.abs(r.cost - cost) < 1e-6, `the example's shelves with ${edge}" off each edge: $${r.cost}, want $${cost}`);
    r.items.forEach((sh, si) => {
      check(sh.edge === edge && sh.L === sh.stock.len && sh.W === sh.stock.wid, `with ${edge}" off each edge, sheet ${si + 1} is ${sh.L} × ${sh.W}, edge ${sh.edge}`);
      sh.placed.forEach(p => check(p.x >= edge - 1e-9 && p.y >= edge - 1e-9 && p.x + p.l <= sh.L - edge + 1e-9 && p.y + p.w <= sh.W - edge + 1e-9, `with ${edge}" off each edge, a part on sheet ${si + 1} runs into the trimmed edge: ${JSON.stringify(p)}`));
      sh.steps.forEach(st => { if (st.line) check(st.line.every((v, i) => v >= edge - 1e-9 && v <= (i % 2 ? sh.W : sh.L) - edge + 1e-9), `with ${edge}" off each edge, a cut runs into the trimmed edge`); });
      if (edge) check(sh.steps[0].on && sh.steps[0].on.trimmed, `with ${edge}" off each edge, the first cut isn't on the trimmed sheet`);
    });
  }
}

console.log('sheets: one on hand and more to buy');
{
  // "Have 1" on the 4×8 keeps a 4×8 to buy as well: six 72" sides need two sheets, one yours and one bought.
  const parts = [{ len: 72, wid: 11.25, qty: 6, grain: true }], ply = [{ len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  let r = K.solveSheets({ kind: 'sheet', stock: [{ len: 96, wid: 48, price: 58, have: 1 }, { len: 96, wid: 48, price: 58, have: 0 }, ...ply], parts }, { kerf: 0.125 });
  check(r.cost === 58 && r.items.length === 2 && r.items.filter(it => it.stock.have).length === 1 && !r.errors.length, `two sheets with one on hand: $${r.cost}, ${r.items.length} sheets, ${JSON.stringify(r.errors)}`);
  // With no 4×8 left to buy, the sides that fit on the sheet on hand are planned, and the rest are left out. The small
  // parts, which a size to buy holds, are planned too.
  r = K.solveSheets({ kind: 'sheet', stock: [{ len: 96, wid: 48, price: 58, have: 1 }, ...ply], parts: [{ len: 20, wid: 10, qty: 2, grain: true }, ...parts] }, { kerf: 0.125 });
  const got = [0, 0]; r.items.forEach(it => it.placed.forEach(p => got[p.pi]++));
  check(got[0] === 2 && got[1] === 4 && r.errors.length === 1 && r.errors[0].pi === 1 && r.errors[0].short === 2 && r.items.some(it => it.stock.have), 'one 4×8 on hand for two sheets of sides: ' + JSON.stringify(got) + ' ' + JSON.stringify(r.errors.map(e => ({ pi: e.pi, short: e.short }))));
}

console.log('sheets: more than 300 of one part');
{
  // Kerf packs at most 300 of a sheet part. The rest used to be left out without a word, so the plan under-bought.
  const r = K.solveSheets({ stock: [{ len: 96, wid: 48, price: 58, have: 0 }], parts: [{ len: 4, wid: 4, qty: 400, grain: false }] }, { kerf: 0.125 });
  check(r.items.reduce((a, s) => a + s.placed.length, 0) === 300, '400 pegs: placed ' + r.items.reduce((a, s) => a + s.placed.length, 0) + ', want 300');
  check(r.errors.length === 1 && r.errors[0].pi === 0 && r.errors[0].max === 300, '400 pegs: the plan doesn’t say it’s short: ' + JSON.stringify(r.errors.map(e => ({ pi: e.pi, max: e.max }))));
}

console.log('boards: more than 500 of one part');
{
  // Kerf plans at most 500 of a board part. A count of 600 used to be cut to 500 in the cut list without a word, so
  // the shopping list came up short; now the count stays as typed and the plan says it's short.
  const r = K.solveBoards({ stock: [{ len: 96, price: 2.98, have: 0 }], parts: [{ len: 3, qty: 600 }] }, { kerf: 0.125, trim: 0 });
  const n = r.items.reduce((a, b) => a + b.pieces.length, 0);
  check(n === 500, '600 pegs: planned ' + n + ', want 500');
  check(r.errors.length === 1 && r.errors[0].pi === 0 && r.errors[0].max === 500, '600 pegs: the plan doesn’t say it’s short: ' + JSON.stringify(r.errors.map(e => ({ pi: e.pi, max: e.max }))));
}

console.log('sheets: strip layouts, as a shop cuts plywood');
{
  // Two jobs the free-rectangle packing alone bought more for: three 78 3/4 × 15 shelves and a few small parts took a
  // 4×8 and a half sheet ($79) where ripping three 15" strips and cutting the small parts from the end takes one 4×8;
  // and a job of full sheets only took six where strips fit it on five. Each plan is a strip layout, every part on
  // its sheet at its size, none overlapping once the kerf is counted, and packing that way again costs the same.
  const P34 = [{ len: 96, wid: 48, price: 58, have: 0 }, { len: 48, wid: 48, price: 34, have: 0 }, { len: 48, wid: 24, price: 21, have: 0 }];
  const parts = l => l.map(([qty, len, wid, grain]) => ({ qty, len, wid, grain }));
  const jobs = [
    ['shelves and small parts', 58, 79, P34, parts([[3, 15.125, 8.625, true], [1, 19.5, 13.875, false], [3, 78.75, 15, false]])],
    ['full sheets only', 290, 348, [P34[0]], parts([[5, 33.5, 10.375, false], [4, 33.125, 12, true], [2, 33.375, 16.625, false], [2, 19.875, 15.625, false], [2, 71.25, 22.5, true], [5, 80.375, 20.25, true], [3, 29.875, 20.375, true]])],
  ];
  for (const [what, want, was, stock, ps] of jobs) {
    const kerf = 0.125, r = K.solveSheets({ stock, parts: ps }, { kerf });
    check(Math.abs(r.cost - want) < 1e-6 && r.run && r.run.strip, `${what}: $${r.cost} (${JSON.stringify(r.run && Object.assign({}, r.run, { order: undefined }))}), want $${want} from a strip layout (it was $${was})`);
    r.items.forEach((sh, si) => sh.placed.forEach((p, i) => {
      const part = ps[p.pi];
      check(p.x > -1e-9 && p.y > -1e-9 && p.x + p.l <= sh.L + 1e-9 && p.y + p.w <= sh.W + 1e-9, `${what}, sheet ${si + 1}: part off the sheet`);
      check((Math.abs(p.l - part.len) < 1e-9 && Math.abs(p.w - part.wid) < 1e-9) || (!part.grain && Math.abs(p.l - part.wid) < 1e-9 && Math.abs(p.w - part.len) < 1e-9), `${what}: a part at the wrong size or turned against its grain`);
      sh.placed.forEach((q, j) => { if (j > i) check(p.x + p.l + kerf <= q.x + 1e-9 || q.x + q.l + kerf <= p.x + 1e-9 || p.y + p.w + kerf <= q.y + 1e-9 || q.y + q.w + kerf <= p.y + 1e-9, `${what}, sheet ${si + 1}: parts overlap`); });
    }));
    check(r.items.reduce((a, sh) => a + sh.placed.length, 0) === ps.reduce((a, p) => a + p.qty, 0), `${what}: not every part placed`);
    const again = K.solveSheets({ stock, parts: ps }, { kerf, replay: r.run });
    check(Math.abs(again.cost - r.cost) < 1e-6 && !again.errors.length, `${what}: packed that way again costs $${again.cost}`);
  }
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

console.log('boards ripped into narrower parts');
{
  // A face frame from a 1×6 (5 1/2" wide): two 1 1/2" stiles and three rails ripped from it, and a full-width shelf.
  // The board is planned like a sheet that wide, but it's still a board plan, pointing at the material's own sizes.
  const stock = [{ id: 'a', len: 72, price: 6.28, have: 0 }, { id: 'b', len: 96, price: 8.28, have: 0 }];
  const frame = { id: 'm', kind: 'board', wid: 5.5, stock, parts: [{ len: 30, wid: 1.5, qty: 2 }, { len: 20, wid: 1.5, qty: 3 }, { len: 30, qty: 1 }] };
  check(K.ripped(frame) && !K.ripped({ ...frame, parts: [{ len: 30, qty: 2 }, { len: 20, wid: 5.5, qty: 1 }] }) && !K.ripped({ ...frame, wid: 0 }), 'which boards are ripped');
  let r = K.solveRip(frame, { kerf: 0.125, trim: 0 });
  check(r.kind === 'board' && r.rip && r.mat === frame && !r.errors.length && Math.abs(r.cost - 8.28) < 1e-9 && r.items.length === 1 && r.items[0].stock === stock[1], `the face frame: $${r.cost} on ${r.items.length} boards, ${JSON.stringify(r.errors)}`);
  check(r.items[0].steps.some(st => st.type === 'rip' && Math.abs(st.at - 1.5) < 1e-9), 'the face frame has no rip at 1 1/2"');
  // Seeded jobs, some with end trim: every part on its board at its size (a part with no width is the board's), never
  // turned, inside the trimmed ends, clear of the others by the kerf, and every one placed.
  const R = rng(23); let n = 0, rips = 0;
  for (let t = 0; t < 120; t++) {
    const kerf = t % 2 ? 0.125 : 0.09375, trim = t % 3 === 0 ? 0.5 : 0, wid = [3.5, 5.5, 7.25][t % 3];
    const parts = Array.from({ length: 1 + Math.floor(R() * 4) }, () => ({ len: Math.round((6 + R() * 60) * 4) / 4, qty: 1 + Math.floor(R() * 4), ...(R() < 0.7 ? { wid: Math.round((0.75 + R() * (wid - 0.75)) * 8) / 8 } : {}) }));
    const mat = { id: 'm', kind: 'board', wid, stock: [{ id: 'a', len: 96, price: 5, have: 0 }, { id: 'b', len: 120, price: 6.5, have: 0 }], parts };
    if (!K.ripped(mat)) continue;
    const r = K.solveRip(mat, { kerf, trim });
    check(!r.errors.length, `job ${t}: ${JSON.stringify(r.errors.map(e => e.pi))}`);
    n++; let count = 0;
    r.items.forEach(b => {
      check(mat.stock.includes(b.stock) && Math.abs(b.W - wid) < 1e-9 && Math.abs(b.L - b.stock.len) < 1e-9 && b.ends === trim, `job ${t}: a board's size`);
      b.steps.forEach(st => { if (st.type === 'rip') rips++; });
      b.placed.forEach((p, i) => {
        count++;
        const part = parts[p.pi], w = part.wid > 0 ? part.wid : wid;
        check(!p.rot && Math.abs(p.l - part.len) < 1e-9 && Math.abs(p.w - w) < 1e-9, `job ${t}: part placed at the wrong size or turned`);
        check(p.x >= trim - 1e-9 && p.x + p.l <= b.L - trim + 1e-9 && p.y > -1e-9 && p.y + p.w <= wid + 1e-9, `job ${t}: part off the board or in its trimmed ends`);
        b.placed.forEach((q, j) => {
          if (j <= i) return;
          check(p.x + p.l + kerf <= q.x + 1e-9 || q.x + q.l + kerf <= p.x + 1e-9 || p.y + p.w + kerf <= q.y + 1e-9 || q.y + q.w + kerf <= p.y + 1e-9, `job ${t}: parts overlap (kerf included)`);
        });
      });
    });
    check(count === parts.reduce((a, p) => a + p.qty, 0), `job ${t}: placed ${count} parts`);
  }
  check(n > 60 && rips > n, `only ${n} ripped jobs, ${rips} rips`);
  console.log('  ' + n + ' jobs, ' + rips + ' rips');
  // A part wider than the board is too big, and the rest are planned.
  r = K.solveRip({ ...frame, parts: [{ len: 30, wid: 7, qty: 1 }, { len: 20, wid: 1.5, qty: 2 }] }, { kerf: 0.125, trim: 0 });
  check(r.errors.length === 1 && r.errors[0].pi === 0 && !r.errors[0].short && r.items.length === 1, 'a part wider than the board: ' + JSON.stringify(r.errors.map(e => e.pi)));
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
  // Two of those rails and the kerf between them are exactly 96", so the tip says it leaves no spare length on the 8'
  // boards. Three 31 7/8" slats leave 1/8" on theirs, so their tip doesn't.
  check(got.tips[0] && got.tips[0].tight === 4 && JSON.stringify(got.tips[0].lens) === '[96]', 'the example’s tip doesn’t note the 8\' boards it leaves no spare length on: ' + JSON.stringify(got.tips[0]));
  got = tipper()(proj('board', [[96, 4.28]], [['Slat', 3, 32]]));
  check(got.tips.length === 1 && got.tips[0].to === 31.875 && got.tips[0].tight === 0, 'three slats: ' + JSON.stringify(got.tips));
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
    ['face frames ripped from 1×6s', () => K.solveRip({ id: 'f', kind: 'board', wid: 5.5, stock: [{ len: 72, price: 6.28, have: 0 }, { len: 96, price: 8.28, have: 0 }],
      parts: [{ len: 30, wid: 1.5, qty: 6 }, { len: 20, wid: 1.5, qty: 9 }, { len: 30, qty: 3 }, { len: 14.25, wid: 2.25, qty: 4 }] }, { kerf: 0.125, trim: 0.25 })],
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
    ['trimming sheet edges', () => { p.edge = 0.125; }, ['ply']],
    ['not trimming them', () => { p.edge = 0; }, ['ply']],
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
    ...['plural', 'sayLen', 'lastIsLeft', 'worthKeeping', 'cfg', 'solveMat', 'planInputs', 'solveAll', 'letter', 'pieceName', 'stepGives', 'marks', 'fmtD', 'sheetSize', 'sawTasks', 'tickKeys'].map(fn),
    'return { solve: function (p) { P = p; U = p.units; solveAll(); var t = sawTasks(); return { keys: tickKeys(t), tasks: t }; } };'
  ].join('\n'))();
  const R = rng(11), pick = a => a[Math.floor(R() * a.length)], q16 = x => Math.round(x * 16) / 16;
  let ids = 0; const id = () => 'x' + ids++;
  // What the saw shows for each material's cuts, with every part's name left out. Letters run through the project, so a
  // part added to another material moves this one's letters along while its ticks stay: each is read back as the
  // letter it would have in its own material alone.
  const toN = l => [...l].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const toL = n => { let s = ''; for (; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + n % 26) + s; return s; };
  const own = (p, mid, t) => { let base = 0; for (const m of p.materials) { if (m.id === mid) break; base += m.parts.length; } return t.replace(/<b>([A-Z]+)<\/b>/g, (_, l) => '<b>' + toL(toN(l) - base) + '</b>'); };
  const text = (page, p) => {
    const names = p.materials.map(m => m.parts.map(q => q.name));
    p.materials.forEach(m => m.parts.forEach(q => { q.name = ''; }));
    const out = {};
    try { page.solve(p).tasks.forEach(t => { (out[t.mid] = out[t.mid] || []).push(t.title + ': ' + own(p, t.mid, t.cuts.map(c => c.noCut ? c.note : c.meas + ' ' + c.what + ' / ' + c.sub).join(' ; '))); }); }
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
  // Letters run through the whole project, material after material: 2×4 A–C, ply D, 1×2 E–F. A part added to the 2×4
  // moves the ply's letter on to E, and keeps the ply's tick key, so its ticks stay.
  {
    const page = saw();
    const p = { name: 'P', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', materials: [
      { id: 'b', kind: 'board', name: '2×4', note: '', stock: [{ id: 's', len: 96, price: 4, have: 0 }], parts: [{ id: 'l', name: 'Leg', qty: 2, len: 30 }, { id: 'r', name: 'Rail', qty: 2, len: 20 }, { id: 'c', name: 'Cleat', qty: 1, len: 10 }] },
      { id: 'p', kind: 'sheet', name: 'ply', note: '', stock: [{ id: 't', len: 96, wid: 48, price: 58, have: 0 }], parts: [{ id: 'h', name: 'Shelf', qty: 2, len: 30, wid: 20, grain: true }] },
      { id: 'x', kind: 'board', name: '1×2', note: '', stock: [{ id: 'u', len: 96, price: 3, have: 0 }], parts: [{ id: 'e', name: 'Edge', qty: 2, len: 30 }, { id: 'f', name: 'Stop', qty: 2, len: 12 }] }] };
    const letters = got => { const o = {}; got.tasks.forEach(t => t.cuts.forEach(c => ((c.what || c.note || '').match(/<b>[A-Z]+<\/b> \w+/g) || []).forEach(x => { (o[t.mid] = o[t.mid] || new Set()).add(x.replace(/<\/?b>/g, '')); }))); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort().join(', ')])); };
    let got = page.solve(p);
    check(JSON.stringify(letters(got)) === JSON.stringify({ b: 'A Leg, B Rail, C Cleat', p: 'D Shelf', x: 'E Edge, F Stop' }), 'the saw doesn’t letter the parts through the project: ' + JSON.stringify(letters(got)));
    const plyKey = got.keys.p;
    p.materials[0].parts.push({ id: 'n', name: 'Brace', qty: 1, len: 8 });
    got = page.solve(p);
    check(letters(got).p === 'E Shelf' && letters(got).x === 'F Edge, G Stop', 'a part added to the 2×4 didn’t move the later letters on: ' + JSON.stringify(letters(got)));
    check(got.keys.p === plyKey, 'a part added to the 2×4 changed the ply’s tick key');
  }
}

console.log('offcuts worth keeping');
{
  // An offcut as long as Keep offcuts over is worth keeping, though the sums leave it a hair short: 2400 mm less 1980,
  // 114 and two 3 mm kerfs is 300 mm, and came to 11.811023622047232" against a keep of 11.811023622047244".
  const saw = new Function([
    ...SOLVER, 'var P = null, RES = null, CUR = "$";', line('var PLANS = '),
    ...['plural', 'sayLen', 'lastIsLeft', 'worthKeeping', 'cfg', 'solveMat', 'planInputs', 'solveAll', 'letter', 'pieceName', 'stepGives', 'marks', 'fmtD', 'sheetSize', 'sawTasks'].map(fn),
    'return function (p) { P = p; U = p.units; PLANS = {}; solveAll(); return sawTasks().map(function (t) { return t.note || ""; }); };'
  ].join('\n'))();
  const mm = x => x / 25.4;
  const proj = (units, kerf, keep, m) => ({ name: 'P', units, kerf, trim: 0, keep, cur: '$', materials: [Object.assign({ id: 'm', name: 'M', note: '' }, m)] });
  const jobs = [
    ['a 300 mm offcut, keeping 300 mm', proj('mm', mm(3), mm(300), { kind: 'board', stock: [{ id: 's', len: mm(2400), price: 5, have: 0 }], parts: [{ id: 'a', name: 'Rail', qty: 1, len: mm(1980) }, { id: 'b', name: 'Block', qty: 1, len: mm(114) }] }), ['Leaves a 300 mm offcut — worth keeping']],
    ['a 299 mm offcut, keeping 300 mm', proj('mm', mm(3), mm(300), { kind: 'board', stock: [{ id: 's', len: mm(2400), price: 5, have: 0 }], parts: [{ id: 'a', name: 'Rail', qty: 1, len: mm(1981) }, { id: 'b', name: 'Block', qty: 1, len: mm(114) }] }), ['Leaves a 299 mm offcut']],
    // 11 31/32" shows as 12": the saw says a 12" offcut, so it's worth keeping when 12" are.
    ['an 11 31/32" offcut, keeping 12"', proj('in', 3 / 32, 12, { kind: 'board', stock: [{ id: 's', len: 96, price: 5, have: 0 }], parts: [{ id: 'a', name: 'Rail', qty: 1, len: 83 + 15 / 16 }] }), ['Leaves a 12″ offcut — worth keeping']],
    ['an 11 7/8" offcut, keeping 12"', proj('in', 0.125, 12, { kind: 'board', stock: [{ id: 's', len: 96, price: 5, have: 0 }], parts: [{ id: 'a', name: 'Rail', qty: 1, len: 84 }] }), ['Leaves a 11 <span class="fr"><span class="sr">7/8</span><span aria-hidden="true"><sup>7</sup>⁄<sub>8</sub></span></span>″ offcut']],
    ['a sheet leaving 2440 × 300 mm, keeping 300 mm', proj('mm', mm(3), mm(300), { kind: 'sheet', stock: [{ id: 's', len: mm(2440), wid: mm(1220), price: 50, have: 0 }], parts: [{ id: 'a', name: 'Side', qty: 1, len: mm(2440), wid: mm(917), grain: true }] }), ['Leaves a 2440 mm × 300 mm piece — worth keeping']],
  ];
  for (const [what, p, want] of jobs) { const got = saw(p); check(JSON.stringify(got) === JSON.stringify(want), `${what}: the saw says ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
