// Seeded random jobs and edits against what Kerf promises, whatever the job: boards as cheap as can be found,
// sheets whose steps cut exactly the parts drawn and name each once, offcuts marked as their shown length says, and
// a long run of edits that keeps plans, tips and ticks true. Fixed seeds, so every run checks the same cases.
// Run with: node test/invariants.test.cjs   (no dependencies; about ten seconds)
'use strict';
const fs = require('fs');
const path = require('path');

// The app is one HTML file; pull the pieces under test out of it by name, as test/solver.test.cjs does.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing function ' + name);
  for (let k = src.indexOf('{', i), d = 0; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && !--d) return src.slice(i, k + 1);
  }
}
function list(name) { const i = src.indexOf('var ' + name + ' = '); return src.slice(i, src.indexOf('\n  ];', i) + 5); }
function line(start) { const i = src.indexOf(start); if (i < 0) throw new Error('missing ' + start); return src.slice(i, src.indexOf('\n', i)); }
const SOLVER = [
  "var U = 'in', CUR = '$';",
  line('var VULGAR = '), line('var EFFORT = '), line('var SPLITS = '), line('var MINR = '), list('SORTS'), list('FITS'),
  ...['esc', 'plural', 'sixteenths', 'mmOf', 'fmt', 'frac', 'fmtH', 'sayLen', 'parseLen', 'money', 'mulberry', 'bestFill', 'onlyHave', 'solveBoards', 'lastIsLeft', 'orientations',
    'newSheet', 'placeIn', 'fitsStock', 'packRun', 'freeArea', 'evalSheets', 'sheetSteps', 'solveSheets'].map(fn),
];
const K = new Function([...SOLVER, 'return { fmt: fmt, parseLen: parseLen, solveBoards: solveBoards, solveSheets: solveSheets, units: function (u) { U = u; } };'].join('\n'))();
// The page without its DOM: the plans it keeps between edits, the saw's checklist and its tick keys, the tips search
// (each idle step run at once, in turn), which tips are still shown, and the ticks put aside or brought back.
function page() {
  return new Function([
    ...SOLVER, 'var P = null, RES = null, TIPS = [], GEN = 0;', line('var PLANS = '),
    ...['worthKeeping', 'cfg', 'solveMat', 'planInputs', 'solveAll', 'letter', 'pieceName', 'stepGives', 'sawTasks', 'tickKeys', 'findTips', 'tipFor', 'syncTicks'].map(fn),
    'var queue = []; function whenIdle(f) { queue.push(f); } function renderTips() {} function toast() {} function save() {}',
    'return {',
    ' solve: function (p) { P = p; U = p.units; CUR = p.cur || "$"; return solveAll(); },',
    ' forget: function () { PLANS = {}; },',
    ' saw: function () { return sawTasks(); }, keys: function () { return tickKeys(sawTasks()); },',
    ' tips: function () { GEN++; TIPS = []; findTips(GEN); while (queue.length) queue.shift()(); return TIPS; },',
    ' shown: function () { return TIPS.filter(tipFor); }, sync: function () { syncTicks(tickKeys(sawTasks())); }',
    '};'
  ].join('\n'))();
}

let failed = 0;
const seen = {};
// Each kind of failure is told the first three times, and counted.
function check(ok, kind, what) { if (ok) return; failed++; seen[kind] = (seen[kind] || 0) + 1; if (seen[kind] <= 3) console.log('  FAIL ' + kind + ': ' + what); }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const E = 1e-6, q16 = x => Math.round(x * 16) / 16, mm = x => Math.round(x) / 25.4;
const LUMBER = [[96, 4.28], [120, 6.38], [144, 7.68], [192, 10.98]];

// Cheapest possible cost by brute force: every piece into every open board or a new one.
function brute(pieces, stocks, kerf) {
  pieces = pieces.slice().sort((a, b) => b - a);
  let best = Infinity; const bins = [], left = stocks.map(s => s.left);
  (function go(i, cost) {
    if (cost >= best - 1e-9) return;
    if (i === pieces.length) { best = cost; return; }
    const p = pieces[i], tried = new Set();
    for (const b of bins) {
      const key = b.cap + ':' + b.used.toFixed(5); if (tried.has(key)) continue; tried.add(key);
      if (b.used + kerf + p <= b.cap + 1e-9) { const u = b.used; b.used += kerf + p; go(i + 1, cost); b.used = u; }
    }
    const sizes = new Set();
    stocks.forEach((s, si) => {
      const k = s.cap + ':' + s.price + ':' + left[si]; if (sizes.has(k)) return; sizes.add(k);
      if (left[si] > 0 && p <= s.cap + 1e-9) { left[si]--; bins.push({ cap: s.cap, used: p }); go(i + 1, cost + s.price); bins.pop(); left[si]++; }
    });
  })(0, 0);
  return best;
}
// First fit, longest first, on each size to buy alone, each board then on the cheapest size it fits.
function firstFit(pieces, stocks, kerf) {
  let best = Infinity;
  for (const s0 of stocks.filter(s => !isFinite(s.left))) {
    const bins = []; let ok = true;
    for (const p of pieces.slice().sort((a, b) => b - a)) {
      const b = bins.find(b => b.used + kerf + p <= s0.cap + 1e-9);
      if (b) b.used += kerf + p; else if (p <= s0.cap + 1e-9) bins.push({ used: p }); else { ok = false; break; }
    }
    if (ok) best = Math.min(best, bins.reduce((a, b) => a + Math.min(...stocks.filter(s => !isFinite(s.left) && s.cap + 1e-9 >= b.used).map(s => s.price)), 0));
  }
  return best;
}

console.log('boards: random jobs');
{
  // Four kinds, in turn. Small jobs in inches or millimetres, with end trim, offcuts on hand, "Have" on a size to buy,
  // and parts that fill a board exactly or fit two to four to a board with nothing to spare; jobs that leave an
  // offcut of just the length worth keeping (or a 32nd short of it, which shows as that length); and 2×4 jobs of 2 to
  // 88 pieces in up to 11 lengths, mostly past the exact search.
  const R = rng(31), pick = a => a[Math.floor(R() * a.length)], pg = page();
  let n = 0, exact = 0, bruted = 0;
  for (let t = 0; t < 320; t++) {
    const kind = ['small', 'small', 'keep', 'big'][t % 4], big = kind === 'big', metric = !big && R() < 0.4;
    const kerf = big ? 0.125 : metric ? pick([3, 2.5, 4]) / 25.4 : pick([0.125, 0.09375, 0.25, 0.0625]);
    const trim = !big && R() < 0.25 ? (metric ? pick([5, 10]) / 25.4 : pick([0.25, 0.5, 1])) : 0;
    const lens = metric ? [[2400, 6.5], [3000, 8.1], [3600, 9.7], [4800, 13]] : LUMBER;
    const stock = lens.slice(0, big ? 4 : 1 + Math.floor(R() * 4)).map((s, i) => ({ id: 's' + i, len: metric ? s[0] / 25.4 : s[0], price: s[1], have: 0 }));
    if (!big && R() < 0.3) stock.push(Object.assign({}, stock[0], { id: 'h', have: 1 + Math.floor(R() * 2) }));
    if (!big && R() < 0.3) stock.push({ id: 'o', len: metric ? mm(500 + R() * 1500) : q16(20 + R() * 60), price: 0, have: 1 + Math.floor(R() * 3) });
    const cap = Math.max(...stock.map(s => s.len)) - 2 * trim, keep = metric ? 300 / 25.4 : 12, parts = [];
    if (kind === 'keep') {
      // one part leaves the keep length on the shortest board, as a millimetre project sums it in floating point
      const off = metric ? pick([0, 0, 0.2, 1]) / 25.4 : pick([0, 0, 1 / 32, 1 / 16]);
      parts.push({ id: 'p0', name: 'Rail', len: stock[0].len - 2 * trim - kerf - keep + off, qty: 1 });
      if (R() < 0.5) { const a = metric ? mm(100 + R() * 900) : q16(4 + R() * 30); parts[0].len -= a + kerf; parts.push({ id: 'p1', name: 'Block', len: a, qty: 1 }); }
    } else if (big) {
      for (let k = 0, nT = 2 + Math.floor(R() * 10); k < nT; k++) parts.push({ id: 'p' + k, name: 'P' + k, len: q16(6 + R() * 90), qty: 1 + Math.floor(R() * 8) });
    } else {
      for (let k = 0, nT = 1 + Math.floor(R() * (t % 3 ? 4 : 9)); k < nT; k++) {
        const r = R(); let len;
        if (r < 0.15) len = cap;
        else if (r < 0.3) { const d = 2 + Math.floor(R() * 3); len = (stock[0].len - 2 * trim - (d - 1) * kerf) / d; len = metric ? Math.floor(len * 25.4) / 25.4 : Math.floor(len * 16) / 16; }
        else len = metric ? mm(50 + R() * 2000) : q16(2 + R() * 90);
        parts.push({ id: 'p' + k, name: 'P' + k, len, qty: 1 + Math.floor(R() * (t % 3 ? 3 : 6)) });
      }
    }
    const units = metric ? 'mm' : 'in';
    const proj = { name: 'B', units, kerf, trim, keep, cur: '$', materials: [{ id: 'm', kind: 'board', name: 'Board', note: '', stock, parts }], done: {} };
    const r = pg.solve(proj).mats[0];
    if (r.errors.some(e => e.pi === -1)) continue;
    n++;
    const missing = new Set(r.errors.map(e => e.pi)), pieces = [];
    parts.forEach((p, pi) => { if (!missing.has(pi)) for (let q = 0; q < p.qty; q++) pieces.push(p.len); });
    const stocks = stock.map(s => ({ cap: s.len - 2 * trim, price: s.have ? 0 : s.price, left: s.have || Infinity })).filter(s => s.cap > 0);
    const id = `board job ${t} (${pieces.length} pieces, ${units})`;
    const placed = r.items.reduce((a, b) => a + b.pieces.length, 0);
    check(placed === pieces.length, 'every piece planned', `${id}: planned ${placed}`);
    check(r.items.every(b => b.need <= b.cap + 1e-9), 'no board overfilled', id);
    if (pieces.length <= 9) {
      const best = brute(pieces, stocks, kerf); bruted++;
      check(r.cost <= best + E, 'as cheap as brute force', `${id}: $${r.cost.toFixed(2)}, $${best.toFixed(2)} is possible`);
      check(r.cost >= best - E, 'no plan cheaper than possible', `${id}: $${r.cost.toFixed(2)} under $${best.toFixed(2)}`);
    }
    if (r.exact) {
      exact++;
      if (pieces.length <= 11) { const best = brute(pieces, stocks, kerf); check(Math.abs(r.cost - best) < E, 'exact means cheapest', `${id}: the exact search's $${r.cost.toFixed(2)}, cheapest $${best.toFixed(2)}`); }
    }
    const ff = firstFit(pieces, stocks, kerf);
    check(r.cost <= ff + E, 'never dearer than first fit', `${id}: $${r.cost.toFixed(2)}, first fit $${ff.toFixed(2)}`);
    // "Leaves a 300 mm offcut — worth keeping" exactly when the length shown is at least Keep offcuts over, as shown.
    K.units(units);
    pg.saw().forEach((task, i) => {
      const b = task.it; if (!(b.offcut > 0)) return;
      const worth = / — worth keeping$/.test(task.note || ''), want = K.parseLen(K.fmt(b.offcut)) >= K.parseLen(K.fmt(keep)) - 1e-9;
      check(worth === want, 'offcut keep agrees with its shown length', `${id}, board ${i + 1}: a ${K.fmt(b.offcut)} offcut (${b.offcut}) with keep ${K.fmt(keep)}: "${task.note}"`);
    });
    K.units('in');
  }
  console.log(`  ${n} jobs, ${bruted} against brute force, ${exact} solved exactly`);
}

console.log('sheets: random jobs, the steps replayed at the saw');
{
  // Parts that tile a sheet exactly, full-length strips and the strip a rip leaves, inches or millimetres.
  const R = rng(37), pick = a => a[Math.floor(R() * a.length)];
  let n = 0, steps = 0, left = 0;
  for (let t = 0; t < 100; t++) {
    const metric = R() < 0.3;
    const kerf = metric ? pick([3, 2.5, 4]) / 25.4 : pick([0.125, 0.09375, 0.25, 0]);
    const stock = metric ? [{ len: 2440 / 25.4, wid: 1220 / 25.4, price: 62, have: 0 }] : [{ len: 96, wid: 48, price: 58, have: 0 }];
    if (R() < 0.4) stock.push({ len: stock[0].len / 2, wid: stock[0].wid, price: 34, have: 0 });
    if (R() < 0.3) stock.push({ len: q16(12 + R() * 40), wid: q16(10 + R() * 30), price: 0, have: 1 + Math.floor(R() * 2) });
    const L = stock[0].len, W = stock[0].wid, parts = [];
    for (let k = 0, nT = 1 + Math.floor(R() * 6); k < nT; k++) {
      const r = R(); let len, wid;
      if (r < 0.2) { const d = 1 + Math.floor(R() * 4), e = 1 + Math.floor(R() * 3); len = (L - (d - 1) * kerf) / d; wid = (W - (e - 1) * kerf) / e; }
      else if (r < 0.3) { len = L; wid = q16(2 + R() * 20); }
      else { len = q16(2 + R() * 60); wid = q16(2 + R() * 30); }
      if (metric) { len = Math.floor(len * 25.4) / 25.4; wid = Math.floor(wid * 25.4) / 25.4; }
      parts.push({ len, wid, qty: 1 + Math.floor(R() * 5), grain: R() < 0.5 });
    }
    if (R() < 0.3) { const w = q16(6 + R() * 30); parts.push({ len: L, wid: w, qty: 1, grain: true }, { len: L, wid: W - w - kerf, qty: 1, grain: true }); }
    K.units(metric ? 'mm' : 'in');
    const r = K.solveSheets({ stock, parts }, { kerf });
    K.units('in');
    if (r.errors.some(e => e.pi === -1)) continue;
    n++;
    r.items.forEach((sh, si) => {
      const id = `sheet job ${t}, sheet ${si + 1} (${metric ? 'mm' : 'in'})`;
      // Saw it as the steps say, a piece at a time: each cut runs edge to edge across one piece, at the distance it
      // gives, on the piece it names; the far side of a cut that says "what's left is" is that part, and each cut's
      // own part is what's left on the near side once its last cut is made.
      let pieces = [{ x: 0, y: 0, w: sh.L, h: sh.W }];
      const at = (p, g) => sh.placed.some(q => q.pi === g.it.pi && Math.abs(q.x - p.x) < E && Math.abs(q.y - p.y) < E && Math.abs(q.l - p.w) < E && Math.abs(q.w - p.h) < E && Math.abs(q.l - g.l) < E && Math.abs(q.w - g.w) < E);
      let ok = true;
      for (const [k, st] of sh.steps.entries()) {
        if (st.type === 'none') continue;
        steps++;
        const [x1, y1, x2, y2] = st.line, rip = st.type === 'rip';
        const i = pieces.findIndex(p => rip ? Math.abs(p.x - x1) < E && Math.abs(p.x + p.w - x2) < E && y1 > p.y + E && y1 < p.y + p.h - E
          : Math.abs(p.y - y1) < E && Math.abs(p.y + p.h - y2) < E && x1 > p.x + E && x1 < p.x + p.w - E);
        if (i < 0) { check(false, 'every cut runs across a piece', `${id}: step ${k + 1} (${st.type} at ${st.at})`); ok = false; break; }
        const p = pieces[i], of = st.of === 'sheet' ? [sh.L, sh.W] : (/^(?:piece|strip) ([\d.]+)×([\d.]+)$/.exec(st.of) || []).slice(1).map(Number);
        check(Math.abs(of[0] - p.w) < 1e-3 && Math.abs(of[1] - p.h) < 1e-3 && (st.of !== 'sheet' || (p.x === 0 && p.y === 0)), 'each cut names the piece it’s made on', `${id}: step ${k + 1} says ${st.of}, the piece is ${p.w}×${p.h}`);
        check(Math.abs((rip ? y1 - p.y : x1 - p.x) - st.at) < E, 'each cut is at the distance it gives', `${id}: step ${k + 1} says ${st.at}`);
        const near = rip ? { x: p.x, y: p.y, w: p.w, h: y1 - p.y } : { x: p.x, y: p.y, w: x1 - p.x, h: p.h };
        const far = rip ? { x: p.x, y: y1 + kerf, w: p.w, h: p.y + p.h - y1 - kerf } : { x: x1 + kerf, y: p.y, w: p.x + p.w - x1 - kerf, h: p.h };
        if (st.gives) check(at(near, st.gives), 'a cut’s part is what it leaves on its near side', `${id}: step ${k + 1} (${st.type} at ${st.at}) gives part ${st.gives.it.pi}, the near side is ${near.w}×${near.h}`);
        (st.also || []).forEach(g => { left++; check(at(far, g), '"what’s left" is the part beyond the cut', `${id}: step ${k + 1} says what's left is part ${g.it.pi} ${g.l}×${g.w}, it's ${far.w}×${far.h}`); });
        pieces.splice(i, 1, near, far);
        pieces = pieces.filter(q => q.w > 1e-9 && q.h > 1e-9);
      }
      if (!ok) return;
      for (const pl of sh.placed) check(pieces.some(p => Math.abs(p.x - pl.x) < E && Math.abs(p.y - pl.y) < E && Math.abs(p.w - pl.l) < E && Math.abs(p.h - pl.w) < E), 'every part comes off whole', `${id}: part ${pl.pi} ${pl.l}×${pl.w} at ${pl.x},${pl.y}`);
      // Every part named by exactly one step: the cut that gives it, the cut that leaves it, or the whole-sheet note.
      const named = [].concat(...sh.steps.map(s => (s.gives ? [s.gives] : []).concat(s.also || []))).map(g => g.it.pi + '@' + g.l + '×' + g.w).sort();
      const drawn = sh.placed.map(p => p.pi + '@' + p.l + '×' + p.w).sort();
      check(JSON.stringify(named) === JSON.stringify(drawn), 'every part named by exactly one step', `${id}: the steps name ${named.join(', ')}; the sheet holds ${drawn.join(', ')}`);
      if (sh.steps.some(s => s.type === 'none')) check(sh.steps.length === 1 && Math.abs(sh.placed[0].l - sh.L) < E && Math.abs(sh.placed[0].w - sh.W) < E, 'the whole-sheet note only for a whole sheet', id);
      // Each offcut the drawing labels with its size is a piece left over after the steps, of that size.
      for (const f of sh.spare) check(pieces.some(p => Math.abs(p.x - f.x) < E && Math.abs(p.y - f.y) < E && Math.abs(p.w - f.w) < E && Math.abs(p.h - f.h) < E), 'labelled offcuts are real', `${id}: offcut ${f.w}×${f.h} at ${f.x},${f.y}`);
    });
  }
  console.log(`  ${n} jobs, ${steps} cuts replayed, ${left} parts named as what a cut leaves`);
}

console.log('a long run of edits: plans, tips and ticks');
{
  // One page through a long session of seeded edits (with ticks at the saw, tips taken, and going back to an earlier
  // copy of the project, as Undo does). After every edit: the plan kept between edits is the plan a fresh start finds;
  // every tip still shown is true now, saving what it says; and every tick is on the cut it was made on.
  const R = rng(5), pick = a => a[Math.floor(R() * a.length)];
  let ids = 0; const id = () => 'i' + ids++;
  const studs = { id: id(), kind: 'board', name: '2×4', note: '', stock: LUMBER.map(s => ({ id: id(), len: s[0], price: s[1], have: 0 })), parts: [] };
  const ply = { id: id(), kind: 'sheet', name: '¾ ply', note: '', stock: [{ id: id(), len: 96, wid: 48, price: 58, have: 0 }, { id: id(), len: 48, wid: 24, price: 21, have: 0 }], parts: [] };
  for (let k = 0; k < 3; k++) studs.parts.push({ id: id(), name: 'B' + k, qty: 1 + Math.floor(R() * 4), len: q16(10 + R() * 70) });
  for (let k = 0; k < 3; k++) ply.parts.push({ id: id(), name: 'S' + k, qty: 1 + Math.floor(R() * 3), len: q16(8 + R() * 40), wid: q16(6 + R() * 20), grain: R() < 0.5 });
  const p = { name: 'P', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', materials: [studs, ply], done: {} };
  const pg = page(), fresh = page(), hist = [];
  // What a cut is in the wood: its board or sheet (size and place in the plan), and what it cuts and gives, by part id.
  const cutIs = (res, mid, ck) => {
    const mi = p.materials.findIndex(m => m.id === mid); if (mi < 0) return null;
    const r = res.mats[mi], [ii, ci] = ck.split('.').map(Number), it = r.items[ii], parts = p.materials[mi].parts; if (!it) return null;
    const pid = g => [parts[g.it.pi] && parts[g.it.pi].id, g.l, g.w];
    if (it.pieces) { const c = (it.trim > 0 ? [{ trim: it.trim }] : []).concat(it.pieces.map(q => ({ part: parts[q.pi] && parts[q.pi].id, len: q.len })))[ci]; return c ? JSON.stringify([it.stock.id, it.stock.len, ii, c]) : null; }
    const st = it.steps[ci]; return st ? JSON.stringify([it.stock.id, it.L, it.W, ii, st.type, st.at, st.line, st.gives && pid(st.gives), (st.also || []).map(pid)]) : null;
  };
  const shown = (res, proj) => JSON.stringify([res.cost, res.cuts, res.mats.map((r, mi) => [r.mat === proj.materials[mi], r.cost, r.exact, r.errors.map(e => e.pi),
    r.items.map(it => [proj.materials[mi].stock.includes(it.stock), it.price, it.need, it.offcut, it.pieces, it.L, it.W, it.placed, it.steps && it.steps.map(s => [s.type, s.at, s.on, s.gives && s.gives.it.pi, (s.also || []).map(g => g.it.pi)])])])]);
  let res = pg.solve(p), madeOn = {}, ticks = 0, tipsChecked = 0, tipsTaken = 0, searches = 0;
  pg.sync(); pg.tips();
  const tick = () => {
    const saw = pg.saw(); if (!saw.length) return;
    const t = pick(saw), ci = Math.floor(R() * t.cuts.length); if (t.cuts[ci].noCut) return;
    const keys = pg.keys(), d = p.done[t.mid] || (p.done[t.mid] = { key: keys[t.mid], ticks: {}, was: [] }), ck = t.ii + '.' + ci, k = t.mid + '/' + ck + '/' + keys[t.mid];
    if (d.ticks[ck]) { delete d.ticks[ck]; delete madeOn[k]; } else { d.ticks[ck] = 1; madeOn[k] = cutIs(res, t.mid, ck); ticks++; }
  };
  for (let e = 0; e < 150; e++) {
    hist.push(JSON.stringify(Object.assign({}, p, { done: {} })));
    const m = pick(p.materials), sheet = m.kind === 'sheet', q = m.parts.length ? pick(m.parts) : null;
    const [what, edit] = pick([
      ['a new part', () => m.parts.push(sheet ? { id: id(), name: 'n', qty: 1, len: q16(5 + R() * 40), wid: q16(4 + R() * 20), grain: true } : { id: id(), name: 'n', qty: 1, len: q16(5 + R() * 60) })],
      ['a part taken away', () => m.parts.length > 1 && m.parts.splice(m.parts.indexOf(q), 1)],
      ['a part moved', () => { if (m.parts.length > 1) { m.parts.splice(m.parts.indexOf(q), 1); m.parts.splice(Math.floor(R() * (m.parts.length + 1)), 0, q); } }],
      ['a count', () => q && (q.qty = Math.floor(R() * 5))],
      ['a length', () => q && (q.len = q16(R() < 0.1 ? 0 : 5 + R() * 60))],
      // a length a hair too long to fit twice (or three times) on a board or across a sheet, which a tip can fix
      ['a length that just misses', () => q && (q[sheet && R() < 0.5 ? 'wid' : 'len'] = pick(sheet ? [24, 16, 48] : [48, 32, 24, 60]))],
      ['a width', () => q && sheet && (q.wid = q16(4 + R() * 30))],
      ['a name', () => q && (q.name = 'r' + Math.floor(R() * 99))],
      ['grain', () => q && sheet && (q.grain = !q.grain)],
      ['the kerf', () => (p.kerf = pick([0.125, 0.09375, 0.1875]))],
      ['trim', () => (p.trim = pick([0, 0, 0.25, 0.5]))],
      ['units', () => (p.units = p.units === 'in' ? 'mm' : 'in')],
      ['a price', () => (pick(m.stock).price = Math.round(R() * 6000) / 100)],
      ['a size on hand', () => (pick(m.stock).have = pick([0, 0, 1, 2]))],
      ['offcuts worth keeping', () => (p.keep = pick([6, 12, 18, 24]))],
      ['a tip taken', () => { const t = pg.shown()[0]; if (t) { p.materials.find(x => x.id === t.mid).parts.find(x => x.id === t.pid)[t.dim] = t.to; tipsTaken++; } }],
      ['a tick', tick], ['a tick', tick], ['a tick', tick],
      ['back to an earlier copy', () => { if (hist.length > 3) { const old = JSON.parse(hist[hist.length - 1 - Math.floor(R() * 3)]); old.done = p.done; Object.assign(p, old); } }],
    ]);
    edit();
    res = pg.solve(p); pg.sync();
    const copy = JSON.parse(JSON.stringify(p)); fresh.forget();
    const kept = shown(res, p), anew = shown(fresh.solve(copy), copy);
    check(kept === anew, 'a kept plan is the plan a fresh start finds', `edit ${e} (${what})\n    kept  ${kept.slice(0, 160)}\n    fresh ${anew.slice(0, 160)}`);
    for (const t of pg.shown()) {
      tipsChecked++;
      const mi = p.materials.findIndex(x => x.id === t.mid), c = JSON.parse(JSON.stringify(p));
      c.materials[mi].parts.find(x => x.id === t.pid)[t.dim] = t.to;
      const save = res.mats[mi].cost - page().solve(c).mats[mi].cost;
      check(Math.abs(save - t.save) < 0.005, 'every tip shown is true', `edit ${e} (${what}): a tip says $${t.save.toFixed(2)} less, taking it now saves $${save.toFixed(2)}`);
    }
    const keys = pg.keys();
    for (const mid of Object.keys(p.done)) {
      check(p.done[mid].key === keys[mid], 'ticks are kept under the plan’s key', `edit ${e} (${what}): material ${mid}`);
      for (const ck of Object.keys(p.done[mid].ticks)) {
        const was = madeOn[mid + '/' + ck + '/' + keys[mid]];
        check(was !== undefined && was === cutIs(res, mid, ck), 'ticks stay on their cut', `edit ${e} (${what}): tick ${ck} was made on ${was}, is on ${cutIs(res, mid, ck)}`);
      }
    }
    if (e % 5 === 0) { pg.tips(); searches++; }
  }
  console.log(`  150 edits, ${ticks} ticks made, ${searches} tips searches, ${tipsChecked} tips checked (${tipsTaken} taken)`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
