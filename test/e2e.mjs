// Uses Kerf in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Opens the example project, a link and a project file from the kerf-planner skill, works through cuts
// at the saw, and checks it all on a phone with nothing loaded from elsewhere, then once more offline.
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the offline
// checks at the end).
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // A page on the same address that isn't Kerf, for putting things in storage before Kerf starts.
  if (path === '/blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>blank</title>'); return; }
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;

// The Mudroom bench from the kerf-planner skill (skill/kerf-planner/references/kerf-format.md), as make_kerf.py writes it.
const MUDROOM = { kerf: 1, project: {
  name: 'Mudroom bench', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$',
  materials: [
    { kind: 'board', name: '2×4', note: '1½ × 3½ in',
      stock: [{ len: 96, price: 4.28, have: 0 }, { len: 120, price: 6.38, have: 0 }, { len: 30, price: 0, have: 1 }],
      parts: [{ name: 'Leg', qty: 4, len: 16.5 }, { name: 'Long rail', qty: 4, len: 41 }] },
    { kind: 'sheet', name: '¾ plywood', note: '23/32 in actual',
      stock: [{ len: 96, wid: 48, price: 58, have: 0 }],
      parts: [{ name: 'Seat', qty: 1, len: 48, wid: 16, grain: true }] },
  ] } };
// A link the way make_kerf.py makes one: the project, deflated, in base64url after #k1z.
const linkTo = doc => '#k1z' + deflateRawSync(Buffer.from(JSON.stringify(doc))).toString('base64url');

// Projects as Kerf stores them.
let ids = 0;
const id = () => 'e2e' + ids++;
const project = (name, materials, extra = {}) => ({ id: id(), name, units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', updated: Date.now(), materials, done: {}, ...extra });
const board = (name, stock, parts) => ({ id: id(), kind: 'board', name, note: '', stock: stock.map(s => ({ id: id(), price: 0, have: 0, ...s })), parts: parts.map(p => ({ id: id(), ...p })) });
const sheet = (name, stock, parts) => ({ id: id(), kind: 'sheet', name, note: '', stock: stock.map(s => ({ id: id(), price: 0, have: 0, ...s })), parts: parts.map(p => ({ id: id(), grain: true, ...p })) });
const saved = (...projects) => ({ projects: Object.fromEntries(projects.map(p => [p.id, p])), order: projects.map(p => p.id), current: projects[0].id, tab: 'plan', rtab: 'plan' });

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
// A request cut short because the test moved on to another page isn't a problem; any other failure is (a missing file logs an error too).
page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push('failed: ' + r.url()); });
page.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('blob:')) problems.push('left the site: ' + u); });

// Opens Kerf as a fresh page load, with `db` in storage (null for a first visit, or text to store as it is) and
// `hash` after the address. Going by about:blank makes a link a real page load rather than a jump within the page.
async function open(db, hash = '') {
  await page.goto(base + 'blank');
  await page.evaluate(d => { localStorage.clear(); if (d) localStorage.setItem('kerf.v1', typeof d === 'string' ? d : JSON.stringify(d)); }, db);
  await page.goto('about:blank');
  await page.goto(base + hash);
  await page.waitForSelector('#planOut > *', { state: 'attached' });
}
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('kerf.v1')));
const view = t => page.click(`#tabs button[data-t="${t}"]`);
const fitsPhone = async what => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `the ${what} scrolls sideways on a phone`);
const cutsFact = () => page.evaluate(() => [...document.querySelectorAll('.fact')].map(f => f.textContent).filter(t => /cut/.test(t))[0]);
// Text as it shows: a typeset fraction carries a plain 15/16 for screen readers, so its text reads 15/1615⁄16.
const shown = t => t.replace(/(\d+)\/(\d+)(?=\1⁄\2)/g, '');
// Ticks the next `n` cuts not ticked yet, in order, on page `p`: a board or sheet finished folds away, so the cuts in
// sight move up.
const tickNext = async (n, p = page) => { for (let i = 0; i < n; i++) await p.locator('#sawOut .cut[data-k][aria-checked="false"]').first().click(); };
// Opens every folded board and sheet at the saw, and gives the keys of the cuts ticked.
const tickedRows = async () => {
  const folded = page.locator('#sawOut .stk.fold [data-fold]');
  while (await folded.count()) await folded.first().click();
  return page.$$eval('#sawOut .cut[data-k]', els => els.filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.dataset.k));
};
const sawSteps = () => page.$$eval('#sawOut .cut[data-k]', els => els.map(e => e.querySelector('small').textContent)).then(a => a.map(shown));
// Saves the shop PDF and returns it as text (its streams aren't compressed).
async function shopPdf() {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pdfBtn')]);
  return (await readFile(await dl.path())).toString('latin1');
}
const pdfKerfLines = pdf => (pdf.match(/0\.14 0\.38 0\.8 RG 1 w [\d. ]+ m [\d. ]+ l S/g) || []).length; // solid blue: a board's saw cuts
// The PDF's lines of text, and how wide each is in Helvetica (the widths Kerf's own table uses, by character code).
const pdfRuns = pdf => [...pdf.matchAll(/BT \/(F1|F2) ([\d.]+) Tf [\d. ]+ rg ([\d.-]+) ([\d.-]+) Td \(((?:\\.|[^\\)])*)\) Tj ET/g)]
  .map(m => ({ bold: m[1] === 'F1', size: +m[2], x: +m[3], y: +m[4], text: m[5].replace(/\\(.)/g, '$1') }));
// The same, page by page: each page of Kerf's PDF is one content stream, in order.
const pdfPages = pdf => [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => pdfRuns(m[1]));
const kerfSource = await readFile(join(root, 'index.html'), 'utf8');
const HELVETICA = { true: kerfSource.match(/HB: '([\d,]+)'/)[1].split(',').map(Number), false: kerfSource.match(/\bH: '([\d,]+)'/)[1].split(',').map(Number) };
const pdfWidth = r => [...r.text].reduce((w, ch) => { const c = ch.charCodeAt(0); return w + (c >= 32 && c <= 126 ? HELVETICA[r.bold][c - 32] : { 128: 556, 133: 1000, 151: 1000, 215: 584, 183: 278 }[c] || 1000); }, 0) * r.size / 1000;

// A first visit opens the example: the legs, rails and shelves cost $100.64.
await open(null);
await page.evaluate(() => document.fonts.ready);
assert.equal(await page.textContent('.total'), '$100.64');
assert.match(await page.textContent('.facts'), /8\s*boards\s*1\s*sheet\s*26\s*cuts/);
// The 2×4s' plan is proved the cheapest (the exact search finished), and the total says so for them; the plywood's isn't.
assert.equal(await page.textContent('.proved'), '2×4: cheapest possible');
await fitsPhone('plan');
await view('list');
await fitsPhone('cut list');
await view('saw');
await fitsPhone('saw checklist');

// Ticks at the saw are kept: three cuts done, a reload, and they're still done.
const cuts = page.locator('#sawOut .cut[data-k]');
for (let i = 0; i < 3; i++) await cuts.nth(i).click();
assert.equal(await page.textContent('.saw-bar b'), '3 of 26 cuts');
await page.waitForTimeout(600);
await page.reload();
await page.waitForSelector('#sawOut .cut[data-k]');
assert.equal(await page.textContent('.saw-bar b'), '3 of 26 cuts', 'ticks survive a reload');
// board 1, its three cuts done, is folded to its heading, and opens on a tap with its ticks
assert.equal(shown(await page.textContent('#sawOut .stk.fold.done .stk-hd')).replace(/›$/, ''), 'Board 12×4 · 10′3/3 ✓');
await page.click('#sawOut .stk.done [data-fold]');
assert.equal(await cuts.nth(2).getAttribute('aria-checked'), 'true');

// The screen stays on while the checklist at the saw is in sight: Kerf asks for a screen wake lock there, lets go of it
// on another tab, and asks again when the page comes back (the browser lets go of it whenever the page is hidden).
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.addInitScript(() => {
    window.wakeLog = [];
    let held = null;
    const lock = () => {
      const l = new EventTarget();
      l.release = async () => { if (held === l) { held = null; wakeLog.push('release'); l.dispatchEvent(new Event('release')); } };
      return (held = l);
    };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async type => { wakeLog.push('request ' + type); return lock(); } } });
    // a page that goes out of sight, the way a phone's lock button or the app switcher hides it
    window.hide = hidden => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      if (hidden && held) held.release();
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await p.goto(base);
  await p.waitForSelector('#sawOut .cut[data-k]');
  const log = () => p.evaluate(() => wakeLog.join(', '));
  await p.waitForFunction(() => wakeLog.length === 1);
  assert.equal(await log(), 'request screen', 'no wake lock at the saw');
  await p.click('#tabs button[data-t="plan"]');
  await p.waitForFunction(() => wakeLog.length === 2);
  assert.equal(await log(), 'request screen, release', 'the wake lock is kept on the plan');
  await p.click('#tabs button[data-t="list"]');
  await p.click('#tabs button[data-t="saw"]');
  await p.evaluate(() => hide(true));
  await p.evaluate(() => hide(false));
  await p.waitForFunction(() => wakeLog.length === 5);
  assert.equal(await log(), 'request screen, release, request screen, release, request screen', 'the wake lock isn’t asked for again when the page comes back');
  await p.click('#tabs button[data-t="list"]');
  await p.waitForFunction(() => wakeLog.length === 6);
  assert.equal((await log()).split(', ').pop(), 'release', 'the wake lock is kept behind the cut list');
  await p.close();
}

// The first cut not ticked is marked as the next to make, and a tick moves the mark on. Kerf opened afresh at the saw
// (a home-screen app the phone closed overnight) starts at that cut, not at the top, three screens of boards above it.
{
  await open(null);
  await view('saw');
  for (let i = 0; i < 20; i++) await page.locator('#sawOut .cut[data-k][aria-checked="false"]').first().click();
  const nextCut = p => p.$eval('#sawOut .cut.next', c => [c.dataset.k, c.querySelector('.nx').textContent, c.getBoundingClientRect().top >= 0 && c.getBoundingClientRect().bottom <= innerHeight]);
  // the cuts not ticked, in order: boards finished fold away
  const keys = Array(20).fill('').concat(await page.$$eval('#sawOut .cut[data-k][aria-checked="false"]', els => els.map(e => e.dataset.k)));
  assert.equal(await page.locator('#sawOut .cut.next').count(), 1, 'more than one cut is marked next');
  assert.deepEqual((await nextCut(page)).slice(0, 2), [keys[20], 'Next'], 'the next cut isn’t the first not ticked');
  await page.waitForTimeout(600);
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.waitForSelector('#sawOut .cut[data-k]');
  assert.deepEqual(await nextCut(p), [keys[20], 'Next', true], 'opened at the saw, the next cut is out of sight');
  assert.ok(await p.evaluate(() => scrollY > 0));
  await p.click('#sawOut .cut.next');
  assert.equal((await nextCut(p))[0], keys[21], 'a tick didn’t move the next mark on');
  await p.close();
}

// The saw counts the cuts the plan counts: a part that comes off with no cut is a note, not a cut to tick. The
// example's tip makes each pair of rails fill an 8' board, so the second rail is what's left.
{
  const sawTotal = async () => +(await page.textContent('.saw-bar b')).match(/of (\d+)/)[1];
  await open(null);
  assert.equal(await sawTotal(), parseInt(await cutsFact()), 'the saw counts more cuts than the plan');
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  await page.click('[data-tip]');
  await page.waitForTimeout(600);
  assert.equal(parseInt(await cutsFact()), 22);
  assert.equal(await sawTotal(), 22, 'after the tip, the saw counts more cuts than the plan');
  assert.ok(shown(await page.textContent('#sawOut')).includes('What’s left should be B Front & back rail (47 15⁄16″). Measure it, and trim it if the board ran long.'), 'no note for a rail that needs no cut');
  // It reads as a line of text: the letter sits a space after "is", not spread out like the parts of a cut's row.
  await view('saw');
  assert.ok(await page.$eval('#sawOut .cut.note b', b => { const r = document.createRange(); r.selectNodeContents(b.previousSibling); return b.getBoundingClientRect().left - r.getBoundingClientRect().right < 6; }), 'the no-cut note is spread out');
}

// Ticks stay on the cut they were made on. Each material keeps its own, keyed to what its cuts are, so an edit to
// another material leaves them be, and a change that comes back (a count changed and changed back) brings them back.
// When a material's plan does change, its ticks clear and a toast says so; none ever lands on a different cut.
{
  const toastNow = () => page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.firstChild.textContent : ''; });
  const part = (mat, i, f) => page.locator(`#mats .mat >> nth=${mat}`).locator(`.prow[data-pid] input[data-f="${f}"] >> nth=${i}`);
  const settle = () => page.waitForTimeout(600);
  await open(null);
  await view('saw');
  await tickNext(4);
  const four = await tickedRows();
  assert.equal(four.length, 4);
  await view('list');
  await part(1, 0, 'wid').fill('23 1/2');
  await settle();
  await view('saw');
  assert.deepEqual(await tickedRows(), four, 'an edit to the plywood moved or cleared the 2×4 ticks');
  assert.equal(await page.textContent('.saw-bar b'), '4 of 26 cuts');
  assert.equal(await toastNow(), '', 'a toast for ticks that weren’t cleared');
  // Side rails 8, then 9: the 2×4 plan changes, so its ticks clear and a toast says so. Back to 8, and they're back.
  await view('list');
  await part(0, 2, 'qty').fill('9');
  await settle();
  assert.equal(await toastNow(), 'The 2×4 plan changed, so its 4 ticked cuts were cleared');
  await view('saw');
  assert.deepEqual(await tickedRows(), [], 'ticks stayed on a plan that changed');
  await view('list');
  await part(0, 2, 'qty').fill('8');
  await settle();
  assert.equal(await toastNow(), 'The 2×4 plan is back, and so are its 4 ticked cuts');
  await view('saw');
  assert.deepEqual(await tickedRows(), four, 'the ticks didn’t come back with their plan');
  // Renaming a part keeps them.
  await view('list');
  await part(0, 1, 'pname').fill('Long rail');
  await settle();
  await view('saw');
  assert.deepEqual(await tickedRows(), four, 'renaming a part cleared the ticks');

  // Trimming each board end adds a cut to every board: the two rails ticked on board 1 clear, with a toast, and
  // nothing is ticked on the new "Square up one end" or anywhere else.
  await open(null);
  await view('saw');
  await cuts.nth(0).click();
  await cuts.nth(1).click();
  assert.equal(await page.textContent('.saw-bar b'), '2 of 26 cuts');
  await page.click('#setBtn');
  await page.fill('#sTrim', '1/4');
  await page.click('#stx');
  await settle();
  assert.equal(await toastNow(), 'The 2×4 plan changed, so its 2 ticked cuts were cleared');
  assert.deepEqual(await tickedRows(), [], 'a tick moved onto another cut when trim was turned on');
  assert.match(await page.textContent('#sawOut .cut[data-k] .what'), /^Next Square up one end/);
  assert.match(await page.textContent('.saw-bar b'), /^0 of /);

  // A sheet part resized where it sits: the full sheet's rip moves from 20" to 25", so its tick clears.
  await open(saved(project('One shelf', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Shelf', qty: 1, len: 30, wid: 20 }])])));
  await view('saw');
  assert.match(await page.textContent('#sawOut .cut[data-k] .what'), /^Next Rip the full sheet/);
  assert.equal(await page.textContent('#sawOut .cut[data-k] .meas'), '20″');
  await cuts.nth(0).click();
  await view('list');
  await part(0, 0, 'wid').fill('25');
  await settle();
  assert.equal(await toastNow(), 'The ¾ plywood plan changed, so its ticked cut was cleared');
  await view('saw');
  assert.equal(await page.textContent('#sawOut .cut[data-k] .meas'), '25″');
  assert.deepEqual(await tickedRows(), [], 'the tick on the 20" rip moved to the 25" one');
}

// A part's ✕ removes it at once, and Undo puts it back: the same plan, and the same ticks at the saw. Start over can
// be undone too.
{
  const plan = () => page.evaluate(() => [...document.getElementById('planOut').children].filter(c => c.id !== 'tips').map(c => c.outerHTML).join('') + document.getElementById('sawOut').innerHTML);
  await open(null);
  await view('saw');
  await tickNext(3); // board 1, which folds; then board 2's last cut
  await cuts.nth(2).click();
  const ticks = await tickedRows(), before = await plan();
  await view('list');
  await page.click('[data-a="delpart"] >> nth=1');
  assert.deepEqual(await page.$$eval('.prow[data-pid] input[data-f="pname"]', is => is.map(i => i.value)), ['Leg', 'Side rail', 'Shelf']);
  assert.equal(await page.evaluate(() => document.getElementById('toast').firstChild.textContent), 'Removed Front & back rail and cleared 4 ticked cuts');
  assert.equal(await page.$eval('#toast', t => getComputedStyle(t).pointerEvents), 'auto', 'a toast with Undo doesn’t take taps');
  await page.click('#toast .lbtn');
  assert.equal(await page.$eval('#toast', t => t.classList.contains('show') && /^The 2×4 plan is back/.test(t.textContent) && getComputedStyle(t).pointerEvents), 'none', 'after Undo, the toast still takes taps');
  assert.deepEqual(await page.$$eval('.prow[data-pid] input[data-f="pname"]', is => is.map(i => i.value)), ['Leg', 'Front & back rail', 'Side rail', 'Shelf'], 'Undo didn’t put the part back where it was');
  await view('saw');
  assert.deepEqual(await tickedRows(), ticks, 'Undo didn’t bring the ticks back');
  assert.equal(await plan(), before, 'Undo didn’t bring the same plan back');
  await page.click('#sawReset');
  assert.deepEqual(await tickedRows(), []);
  assert.equal(await page.evaluate(() => document.getElementById('toast').firstChild.textContent), 'Cleared 4 ticks');
  await page.click('#toast .lbtn');
  assert.deepEqual(await tickedRows(), ticks, 'Undo after Start over didn’t bring the ticks back');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#sawOut .cut[data-k]');
  assert.deepEqual(await tickedRows(), ticks, 'ticks brought back by Undo weren’t saved');
}

// A link from the kerf-planner skill shows what's in it and comes in as a new project once you say so.
await open(null, linkTo(MUDROOM));
await page.waitForSelector('#lkAdd');
assert.match(await page.textContent('#sheet .lk'), /Mudroom bench\s*2×4 — 8 pieces\s*¾ plywood — 1 piece/, 'the link counts pieces, as Projects counts parts');
// Nothing in it is ringed: the page hasn't been touched yet, so a focused button would show its focus ring.
assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'the link dialog opens with a button ringed');
assert.equal(await page.evaluate(() => location.hash), '', 'the project leaves the address bar');
await page.click('#lkAdd');
assert.equal(await page.inputValue('#pname'), 'Mudroom bench');
assert.equal(await page.textContent('.total'), '$70.76');
// It's the first project here, so it takes the place of the example, which was never changed.
assert.deepEqual(Object.values((await stored()).projects).map(p => p.name), ['Mudroom bench'], 'the untouched example stayed');
// An example you changed (a price, a tick at the saw) stays, and so does the example beside a
// project of your own.
for (const [what, change] of [
  ['a price', async () => { await view('list'); await page.click('#mats .mat >> nth=0 >> details.stock summary'); await page.fill('#mats .mat >> nth=0 >> .srow[data-sid] [data-f="price"] >> nth=0', '4.50'); }],
  ['a tick', async () => { await view('saw'); await page.locator('#sawOut .cut[data-k]').first().click(); }],
]) {
  await open(null);
  await change();
  await page.waitForFunction(() => localStorage.getItem('kerf.v1'), null, { timeout: 3000 });
  await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
  await page.click('#lkAdd');
  assert.deepEqual(Object.values((await stored()).projects).map(p => p.name).sort(), ['Garage shelves (example)', 'Mudroom bench'], 'an example with ' + what + ' changed went');
}
{
  await open(null);
  await page.click('#projBtn'); await page.click('#pjNew');
  await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
  await page.click('#lkAdd');
  assert.deepEqual(Object.values((await stored()).projects).map(p => p.name).sort(), ['Garage shelves (example)', 'Mudroom bench', 'Untitled project'], 'the example went though it wasn’t the only project');
}
await open(null, linkTo(MUDROOM));
await page.click('#lkAdd');

// On an iPhone a tapped link opens in Safari, whose projects aren't the ones Kerf on the home screen keeps: there the
// link says so and offers itself to copy, the whole link, though the page has taken it out of the address bar. Not
// on other phones, and not in Kerf opened from the home screen.
{
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const note = 'Using Kerf from your home screen? It keeps its own projects — copy this link and paste it under Projects there.';
  for (const [what, ua, standalone, want] of [['Safari on an iPhone', IPHONE, false, true], ['Kerf on an iPhone’s home screen', IPHONE, true, false], ['another phone', undefined, false, false]]) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(ua ? { userAgent: ua } : {}) });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push(e.message));
    await p.addInitScript(standalone => {
      if (standalone) Object.defineProperty(navigator, 'standalone', { get: () => true });
      Object.defineProperty(navigator, 'clipboard', { get: () => ({ writeText: t => { window.copied = t; return Promise.resolve(); } }) });
    }, standalone);
    const hash = linkTo(MUDROOM);
    await p.goto(base + hash);
    await p.waitForSelector('#lkAdd');
    assert.equal((await p.textContent('#sheet')).includes(note), want, what + ': the note about the home screen');
    if (want) {
      assert.equal(await p.evaluate(() => location.hash), '', 'the link is still in the address bar');
      await p.click('#lkCopy');
      assert.equal(await p.evaluate(() => window.copied), base + hash, 'Copy link copies something else');
      await p.waitForFunction(() => document.getElementById('toast').textContent === 'Link copied — paste it under Projects in Kerf on your home screen');
    }
    await c.close();
  }
}

// The same plan saved as a .kerf.json file opens from Projects, shown first the way a link is.
const file = { kerf: 1, project: { ...MUDROOM.project, name: 'Garage bench' } };
await page.click('#projBtn');
await page.setInputFiles('#pjFile', { name: 'garage-bench.kerf.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file, null, 1)) });
await page.waitForSelector('#lkAdd');
assert.equal(await page.textContent('#sheet h2'), 'Open a project file');
assert.match(await page.textContent('#sheet .lk'), /^Garage bench\s*2×4 — 8 pieces/);
await page.click('#lkAdd');
await page.waitForFunction(() => document.getElementById('pname').value === 'Garage bench');
assert.ok(await page.isHidden('#sheet'), 'Projects closes once the file is open');
assert.equal(await page.textContent('.total'), '$70.76');
assert.equal((await stored()).order.length, 2);

// make_kerf.py itself, run on the plan in its own instructions: the link and the file it writes open in Kerf with the
// plan's names, counts and lengths. It writes into a folder of its own in the system's temporary folder, removed after.
{
  const script = join(root, 'skill', 'kerf-planner', 'scripts', 'make_kerf.py');
  const doc = (await readFile(script, 'utf8')).match(/\n(\{\n[\s\S]*?\n\})\n/)[1].replace(/\s+#.*$/gm, '');
  const tmp = mkdtempSync(join(tmpdir(), 'kerf-make-'));
  try {
    writeFileSync(join(tmp, 'plan.json'), doc);
    const run = spawnSync('python3', ['-I', '-B', script, join(tmp, 'plan.json'), '--out', tmp, '--base', base], { encoding: 'utf8' });
    if (run.error && run.error.code === 'ENOENT') console.log('  (no python3 here, so make_kerf.py was not run)');
    else {
      assert.equal(run.status, 0, 'make_kerf.py failed on its own plan:\n' + run.stdout + run.stderr);
      const link = /^Link: (\S+)$/m.exec(run.stdout)[1], path = /^File: (.+)$/m.exec(run.stdout)[1];
      assert.ok(link.startsWith(base + '#k1z') && path.startsWith(tmp), 'make_kerf.py’s link and file: ' + link.slice(0, 60) + ' ' + path);
      // What the cut list shows: each material's name, sizes to buy and parts (name, count, length and width).
      const cutList = () => page.$$eval('#mats .mat', ms => ms.map(m => [m.querySelector('[data-f="mname"]').value,
        [...m.querySelectorAll('.srow[data-sid]')].map(r => [...r.querySelectorAll('[data-f="slen"], [data-f="swid"]')].map(i => i.value).join(' × ')),
        [...m.querySelectorAll('.prow[data-pid]')].map(r => [...r.querySelectorAll('[data-f="pname"], [data-f="qty"], [data-f="len"], [data-f="wid"]')].filter(i => i.getClientRects().length).map(i => i.value).join(' / '))]));
      // the 1×6's stiles ripped from it, 1 1/2" wide
      const want = [['2×4', ["8'", "10'", "2' 6\""], ['Leg / 4 / 17 1/4"']], ['1×6 board', ["8'"], ['Stile / 2 / 30" / 1 1/2"']], ['¾ plywood', ['96" × 48"'], ['Seat / 1 / 48" / 16"']]];
      await open(null, link.slice(base.length));
      await page.waitForSelector('#lkAdd');
      assert.match(await page.textContent('#sheet .lk'), /^Mudroom bench\s*2×4 — 4 pieces\s*1×6 board — 2 pieces\s*¾ plywood — 1 piece$/, 'make_kerf.py’s link');
      await page.click('#lkAdd');
      await view('list');
      assert.deepEqual(await cutList(), want, 'make_kerf.py’s link in the cut list');
      assert.equal(await page.inputValue('#pnotes'), 'Pocket screws: 16 × 2½″ for the frame\nFinish: two coats of wipe-on poly', 'make_kerf.py’s notes');
      await page.click('#projBtn');
      await page.setInputFiles('#pjFile', path);
      await page.waitForSelector('#lkAdd');
      assert.match(await page.textContent('#sheet .lk'), /^Mudroom bench\s*2×4 — 4 pieces\s*1×6 board — 2 pieces\s*¾ plywood — 1 piece$/, 'make_kerf.py’s file');
      await page.click('#lkAdd');
      await page.waitForFunction(() => document.getElementById('sheet').hidden);
      assert.deepEqual(await cutList(), want, 'make_kerf.py’s file in the cut list');
      assert.equal((await stored()).projects[(await stored()).current].kerf, 0.125, 'make_kerf.py’s kerf');
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// A link copied with a bit more or less than it should still opens: a full stop or bracket from the sentence around it,
// or %20 where a line wrapped (the address bar keeps the link, so it's the page that has to cope).
for (const [what, hash] of [['a full stop after it', linkTo(MUDROOM) + '.'], ['a bracket after it', linkTo(MUDROOM) + ')'],
  ['%20 inside it', linkTo(MUDROOM).slice(0, 300) + '%20' + linkTo(MUDROOM).slice(300)], ['a quote after it', linkTo(MUDROOM) + '%22']]) {
  await open(null, hash);
  await page.waitForSelector('#lkAdd', { timeout: 5000 }).catch(() => assert.fail(`a link with ${what} doesn’t open`));
  assert.match(await page.textContent('#sheet .lk'), /^Mudroom bench/);
}

// A broken link says so instead of failing quietly, and a good link after it in the same tab still opens.
for (const bad of ['#k1zABCDE', '#project=%E0%A4%A', '#project={"name":"50% off bench"}', '#k1z!!!!', '#k1j', '#k1']) {
  await open(null, bad);
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 3000 }).catch(() => {});
  assert.equal(await page.textContent('#toast'), 'That link doesn’t hold a Kerf project', bad + ' says nothing');
}
await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
await page.waitForSelector('#lkAdd', { timeout: 5000 });
await page.click('#lkx');

// A link pasted into Projects opens as it would from the address bar (on an iPhone a tapped link opens in Safari,
// not in Kerf on the home screen). A broken one says so, and text that's neither says that.
{
  const paste = text => page.evaluate(t => {
    document.getElementById('toast').classList.remove('show'); // so a toast is this paste's
    const data = new DataTransfer(); data.setData('text/plain', t);
    document.getElementById('pjPaste').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  const toastSays = async () => { await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 3000 }).catch(() => {}); return page.textContent('#toast'); };
  await open(null);
  await page.click('#projBtn');
  await paste('https://kerf.junkdrawer.works/' + linkTo({ kerf: 1, project: { ...MUDROOM.project, name: 'Pasted bench' } }));
  await page.waitForSelector('#lkAdd', { timeout: 5000 }).catch(() => assert.fail('a pasted link doesn’t open'));
  assert.match(await page.textContent('#sheet .lk'), /Pasted bench\s*2×4 — 8 pieces/);
  await page.click('#lkAdd');
  assert.equal(await page.inputValue('#pname'), 'Pasted bench');
  await page.click('#projBtn');
  // A link wrapped across lines (as plain-text mail does at 60 or 76 characters), with the next sentence after it, and
  // one rewritten by Outlook's Safe Links, open the same way.
  const named = name => 'https://kerf.junkdrawer.works/' + linkTo({ kerf: 1, project: { ...MUDROOM.project, name } });
  const pasted = [['wrapped at 60', 'Here it is:\n' + named('Wrapped bench').match(/.{1,60}/g).join('\n') + '\nTap it to open Kerf.', 'Wrapped bench'],
    ['wrapped with spaces', named('Spaced bench').match(/.{1,76}/g).join(' \r\n'), 'Spaced bench'],
    ['in Safe Links', 'https://nam12.safelinks.protection.outlook.com/?url=' + encodeURIComponent(named('Outlook bench')) + '&data=05%7C02%7C%7Cabc&sdata=xyz%3D&reserved=0', 'Outlook bench'],
    ['in brackets', '[Open in Kerf](' + named('Markdown bench') + ').', 'Markdown bench']];
  for (const [what, text, name] of pasted) {
    await paste(text);
    await page.waitForSelector('#lkAdd', { timeout: 5000 }).catch(() => assert.fail(`a link ${what} doesn’t open`));
    assert.equal(await page.textContent('#sheet .lk b'), name, what);
    await page.click('#lkx');
    await page.click('#projBtn');
  }
  await paste('https://kerf.junkdrawer.works/#k1zABCDE');
  assert.equal(await toastSays(), 'That link doesn’t hold a Kerf project');
  await paste('https://kerf.junkdrawer.works/#k1z!!!!');
  assert.equal(await toastSays(), 'That link doesn’t hold a Kerf project');
  await paste('a bench, about four feet long');
  assert.equal(await toastSays(), 'That isn’t a Kerf project');
  await page.click('#pjx');
}

// Opening the same plan again offers the copy you have, whether it comes as a link, a file (as the skill writes it, or as
// Kerf saves it) or pasted text: they all carry the same project, so they match. A duplicate isn't that copy, and
// Projects tells copies made today apart by the time.
{
  const pasteIn = text => page.evaluate(t => {
    const data = new DataTransfer(); data.setData('text/plain', t);
    document.getElementById('pjPaste').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  const count = async () => (await stored()).order.length;
  const again = async title => {
    await page.waitForSelector('#lkOpen', { timeout: 5000 }).catch(() => assert.fail(title + ': no offer of the copy already opened'));
    assert.equal(await page.textContent('#sheet h2'), title);
    assert.match(await page.textContent('#sheet .note'), /^You opened this project before; your copy is still in Projects\./);
    await page.click('#lkOpen');
    assert.equal(await page.inputValue('#pname'), 'Mudroom bench');
  };
  await open(null, linkTo(MUDROOM));
  await page.click('#lkAdd');
  assert.equal(await count(), 1);
  await page.click('#projBtn');
  await page.setInputFiles('#pjFile', { name: 'mudroom-bench.kerf.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(MUDROOM, null, 1)) });
  await again('Open a project file');
  await page.click('#projBtn');
  await pasteIn(JSON.stringify(MUDROOM));
  await again('Open pasted project');
  await page.click('#projBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pjExport')]);
  await page.setInputFiles('#pjFile', await dl.path());
  await again('Open a project file');
  assert.equal(await count(), 1, 'opening the same plan again added a copy');
  // Duplicate this one makes a copy that didn't come from the link: opening the link again opens the original.
  await page.click('#projBtn');
  await page.click('#pjDup');
  assert.equal(await page.inputValue('#pname'), 'Mudroom bench copy');
  assert.equal(await page.textContent('#toast'), 'Made “Mudroom bench copy”', 'Duplicate doesn’t name the copy it made');
  await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
  await again('Open a project from a link');
  // Add another copy still adds one.
  await page.click('#projBtn');
  await pasteIn(JSON.stringify(MUDROOM));
  await page.waitForSelector('#lkOpen');
  await page.click('#lkAdd');
  assert.equal(await count(), 3);
  // It takes the next free number, so the two rows can be told apart.
  assert.equal(await page.inputValue('#pname'), 'Mudroom bench (2)', 'another copy came in with the same name');
  // Updated today: the time, so two copies of one name can be told apart; on another day, the date.
  const db = await stored();
  await open({ ...db, projects: { ...db.projects, [db.order[2]]: { ...db.projects[db.order[2]], updated: Date.now() - 3 * 86400000 } } });
  await page.click('#projBtn');
  const rows = await page.$$eval('#pjList .pitem span', s => s.map(x => x.textContent));
  assert.ok(rows.slice(0, 2).every(r => / · \d{1,2}:\d\d/.test(r)), 'a project changed today shows its date, not the time: ' + rows.join(', '));
  assert.ok(!/:/.test(rows[2]), 'a project changed days ago shows a time: ' + rows[2]);
  await page.click('#pjx');
  // A revised design of the same name says on its button that it comes in numbered, and does; opening the first
  // link again still finds a copy it made (the newest, Mudroom bench (2)), not the revised one.
  const revised = { kerf: 1, project: { ...MUDROOM.project, notes: 'Revised: a deeper seat.' } };
  await page.evaluate(hash => { location.hash = hash; }, linkTo(revised));
  await page.waitForSelector('#lkAdd');
  assert.equal(await page.textContent('#lkAdd'), 'Add as “Mudroom bench (3)”');
  await page.click('#lkAdd');
  assert.equal(await page.inputValue('#pname'), 'Mudroom bench (3)');
  assert.equal(await page.textContent('#toast'), 'Opened “Mudroom bench (3)”');
  await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
  await page.waitForSelector('#lkOpen', { timeout: 5000 });
  await page.click('#lkOpen');
  assert.equal(await page.inputValue('#pname'), 'Mudroom bench (2)');
  // A name that isn't taken comes in as it is, and so does one that matches only the example it takes the place of.
  await open(null, linkTo({ kerf: 1, project: { ...MUDROOM.project, name: 'Garage shelves (example)' } }));
  assert.equal(await page.textContent('#lkAdd'), 'Add to my projects');
  await page.click('#lkAdd');
  assert.equal(await page.inputValue('#pname'), 'Garage shelves (example)');
}

// What Kerf saves opens again whole: a project with a long name, 201 parts of one material (one with a long name) and
// 25 sizes of another goes out as a file and back in with every field as it was, ids and ticks aside. Past the limits
// (well past what anyone makes) what's left out is said before it's added, a material with parts and no size gets the
// usual one, and a part written by hand with no count or grain comes in as one, grain-locked, as in the cut list.
{
  const pasteIn = text => page.evaluate(t => {
    document.getElementById('toast').classList.remove('show');
    const data = new DataTransfer(); data.setData('text/plain', t);
    document.getElementById('pjPaste').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  const bare = o => JSON.parse(JSON.stringify(o, (k, v) => ['id', 'updated', 'done', 'from', 'example'].includes(k) ? undefined : v));
  const parts = Array.from({ length: 201 }, (_, i) => ({ name: i === 7 ? 'Upper cabinet left side panel with dado for adjustable shelf pins, 32 mm apart' : 'Part ' + i, qty: i % 4, len: 10 + i / 8 }));
  const sizes = Array.from({ length: 25 }, (_, i) => ({ len: 24 + i * 3, wid: 24 + i, price: 10.25 + i, have: i % 3 }));
  const big = project('A long name for a kitchen: base cabinets, uppers, the pantry and the island, all of it in maple', [
    board('Maple 4/4', [{ len: 96, price: 12.5 }, { len: 120, price: 15.75, have: 2 }], parts),
    sheet('¾ maple plywood', sizes, [{ name: 'Side', qty: 4, len: 30, wid: 23.25, grain: false }, { name: 'Shelf', qty: 6, len: 22.5, wid: 11.25 }]),
  ], { units: 'mm', kerf: 0.09375, trim: 0.5, edge: 0.25, keep: 18, cur: '€' });
  big.materials[1].note = 'A1 grade';
  big.materials[1].examplePrices = true;
  big.notes = 'Hinges: 4 × 35 mm cup\n\nEdge band the shelf fronts';
  await open(saved(big));
  await page.click('#projBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pjExport')]);
  await page.setInputFiles('#pjFile', await dl.path());
  await page.waitForSelector('#lkAdd');
  assert.deepEqual(await page.$$eval('#sheet .note', ns => ns.map(n => n.textContent)), ['It comes in as a new project; nothing you already have changes. Check the prices — they’re whatever the file came with.'], 'a project Kerf saved doesn’t open whole');
  await page.click('#lkAdd');
  const back = await stored();
  assert.equal(back.order.length, 2);
  assert.deepEqual(bare(back.projects[back.order[0]]), { ...bare(big), name: big.name + ' (2)' }, 'a project saved as a file comes back different (numbered beside the one it was saved from)');

  const many = Array.from({ length: 1005 }, (_, i) => ({ name: 'Slat ' + i, qty: 0, len: 20 }));
  many[3] = { name: 'A long name '.repeat(21), qty: 2, len: 30 }; // 252 characters
  await page.click('#projBtn');
  await pasteIn(JSON.stringify({ kerf: 1, project: { name: 'Over the limits', notes: 'Glue up the top. '.repeat(118), materials: [
    { kind: 'board', name: '2×4', parts: many },
    { kind: 'sheet', name: 'Ply', stock: Array.from({ length: 52 }, () => ({ len: 96, wid: 48, price: 58 })), parts: [{ name: 'Side', len: 30, wid: 12 }, { name: 'Back', qty: null, len: 30, wid: 20, grain: false }, { name: 'Spare', qty: 0, len: 10, wid: 10 }, { name: 'Top', qty: '', len: 30, wid: 20 }] },
  ] } }));
  await page.waitForSelector('#lkAdd', { timeout: 5000 });
  assert.equal(await page.textContent('#sheet h2'), 'Open pasted project');
  assert.deepEqual((await page.$$eval('#sheet .note', ns => ns.map(n => n.textContent))).slice(0, 5), [
    'The notes were cut short at 2,000 characters.',
    'Kept the first 1000 parts of 2×4; 5 more were left out.',
    '2×4 came with no size to buy, so it has Kerf’s usual board. Check the sizes.',
    'Kept the first 50 sizes of Ply; 2 more were left out.',
    '1 name was cut short at 200 characters.']);
  await page.click('#lkAdd');
  const over = (await stored()).projects[(await stored()).current];
  assert.equal(over.materials[0].parts.length, 1000);
  assert.deepEqual(over.materials[0].stock.map(s => [s.len, s.price, s.have]), [[96, 5, 0]]);
  assert.equal(over.materials[0].parts[3].name, 'A long name '.repeat(21).slice(0, 200));
  assert.equal(over.materials[1].stock.length, 50);
  assert.equal(over.notes, 'Glue up the top. '.repeat(118).slice(0, 2000));
  assert.deepEqual(over.materials[1].parts.map(p => [p.name, p.qty, p.grain]), [['Side', 1, true], ['Back', 1, false], ['Spare', 0, true], ['Top', 1, true]], 'a part with no count or grain');
  // Nothing in it that can be read: said, not added as an empty project. An empty project, as Kerf saves one, opens.
  await page.click('#projBtn');
  await pasteIn('{"kerf":1,"project":{"name":"Nothing","materials":[null,"board",{"kind":"board"}]}}');
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 3000 });
  assert.equal(await page.textContent('#toast'), 'That isn’t a Kerf project');
  await pasteIn('https://kerf.junkdrawer.works/#project=' + encodeURIComponent('{"name":"Nothing","materials":[{"kind":"sheet"}]}'));
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 3000 });
  assert.equal(await page.textContent('#toast'), 'That link doesn’t hold a Kerf project');
  await pasteIn('{"kerf":1,"project":{"name":"Empty","materials":[]}}');
  await page.waitForSelector('#lkAdd', { timeout: 5000 });
  assert.equal(await page.textContent('#sheet .lk b'), 'Empty');
  await page.click('#lkx');
  assert.equal((await stored()).order.length, 3, 'something unreadable was added');
}

// A project's notes (hardware, glue-ups, finish) sit at the foot of the cut list, are saved with it, and print on the
// shop PDF's first page under the shopping list, line for line, a blank line kept as a gap; ⅛, which the PDF's fonts
// don't have, as 1/8. A project with none prints no heading for them.
{
  await open(saved(project('Bench', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 4, len: 16.5 }])])));
  await view('list');
  assert.equal(await page.inputValue('#pnotes'), '');
  assert.ok(!pdfRuns(await shopPdf()).some(r => r.text === 'NOTES'), 'a project with no notes prints a heading for them');
  const typed = 'Pocket screws: 16 × 2½″\n\nFinish: wipe-on poly; leave the 1⅛″ dowels bare';
  await page.fill('#pnotes', typed);
  await page.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('dowels bare'), null, { timeout: 5000 });
  await page.reload();
  await page.waitForSelector('#planOut > *', { state: 'attached' });
  await view('list');
  assert.equal(await page.inputValue('#pnotes'), typed, 'the notes weren’t kept through a reload');
  const first = pdfPages(await shopPdf())[0], texts = first.map(r => r.text), at = texts.indexOf('NOTES');
  assert.ok(at > texts.indexOf('Total'), 'the notes aren’t under the shopping list on the shop PDF’s first page');
  assert.deepEqual(texts.slice(at + 1, at + 3), ['Pocket screws: 16 \xd7 2\xbd"', 'Finish: wipe-on poly; leave the 1 1/8" dowels bare'], 'the shop PDF’s notes');
  assert.ok(first[at + 2].y < first[at + 1].y - 15, 'the blank line between the notes left no gap');
  await page.fill('#pnotes', '');
  await page.waitForFunction(() => !(localStorage.getItem('kerf.v1') || '').includes('"notes"'), null, { timeout: 5000 });
}

// Opening Kerf writes nothing until something really changes. A first visit that only looks around leaves
// storage empty.
await open(null);
for (const t of ['list', 'saw', 'plan']) await view(t);
await page.waitForTimeout(600);
assert.equal(await page.evaluate(() => localStorage.getItem('kerf.v1')), null, 'opening Kerf and looking around saved the example');
await page.fill('#pname', 'My shelves');
await page.waitForFunction(() => /My shelves/.test(localStorage.getItem('kerf.v1')), null, { timeout: 3000 });
// A project already here isn't written back just by opening it.
{
  const p = project('Opened', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]);
  await open(saved(p));
  await page.waitForTimeout(600);
  assert.deepEqual((await stored()).projects[p.id].done, {}, 'opening a project saved it');
}

// Saving waits a moment for typing to stop, but an edit made just before the page closes is still kept.
{
  const p = project('Quick', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]);
  await open(saved(p));
  await page.evaluate(() => { const i = document.getElementById('pname'); i.value = 'Renamed just now'; i.dispatchEvent(new Event('input', { bubbles: true })); location.reload(); }).catch(() => {});
  await page.waitForLoadState('load');
  await page.waitForSelector('#planOut > *', { state: 'attached' });
  assert.equal(await page.inputValue('#pname'), 'Renamed just now', 'an edit right before a reload was lost');
  // Leaving with nothing waiting to save writes nothing, so a first visit still leaves storage empty.
  await open(null);
  await page.reload();
  await page.waitForSelector('#planOut > *', { state: 'attached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('kerf.v1')), null, 'leaving the page saved the example');
}

// Damaged storage doesn't stop the page. Text that can't be read is kept under kerf.v1.bad and Kerf starts on the
// example; a project with fields of the wrong type opens repaired, with its values as they were.
{
  const before = problems.length;
  const badCopy = () => page.evaluate(() => localStorage.getItem('kerf.v1.bad'));
  for (const bad of ['{"projects":{"a1":{"name":"Shelves","materials":[', '{"projects":["Shelves"],"order":{"length":1},"current":"a1"}', '"kerf"']) {
    await open(bad);
    assert.equal(await page.textContent('.total'), '$100.64', 'the example doesn’t open over ' + bad);
    assert.equal(await badCopy(), bad, 'the text that couldn’t be read isn’t kept');
  }
  const odd = project('Wrong types', [board('2×4', [{ len: '96', price: '4.28' }], [{ name: 7, qty: '2', len: '30' }]), null, 'board'], { units: 'cm', done: 'none' });
  const raw = JSON.stringify(saved(odd));
  await open(raw);
  assert.equal(await page.inputValue('#pname'), 'Wrong types');
  assert.equal(await page.textContent('.total'), '$4.28');
  await view('saw');
  await page.locator('#sawOut .cut[data-k]').first().click();
  assert.equal(await page.textContent('.saw-bar b'), '1 of 2 cuts');
  await view('list');
  assert.deepEqual([await page.inputValue('.prow[data-pid] input[data-f="pname"]'), await page.inputValue('.prow[data-pid] input[data-f="qty"]')], ['7', '2']);
  assert.equal(await badCopy(), raw, 'what was stored before the repair isn’t kept');
  assert.deepEqual(problems.slice(before), [], 'damaged storage stopped the page');
  await open(saved(project('Fine', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])])));
  assert.equal(await badCopy(), null, 'a good save was kept as damaged');
  // When storage is too full to keep the damaged copy, the projects are still saved.
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'kerf.v1.bad') throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); };
    const db = JSON.parse(localStorage.getItem('kerf.v1') || 'null') || { projects: {}, order: [] };
    localStorage.setItem('kerf.v1', JSON.stringify({ ...db, order: 'damaged' }));
  });
  await page.fill('#pname', 'Saved anyway');
  await page.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('Saved anyway'), null, { timeout: 3000 })
    .catch(() => assert.fail('the projects weren’t saved when the damaged copy couldn’t be kept'));
  // What couldn't be read is said, under the top bar, and the copy kept can be saved as a file; Not now puts it away.
  const notice = () => page.textContent('#storeBar');
  await open('hello');
  assert.equal(await notice(), 'Kerf couldn’t read everything this browser had saved. What it could read is here; the rest is kept as it was.Save the damaged copy as a fileNot now');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#storeBar button >> text=Save the damaged copy as a file')]);
  assert.equal(dl.suggestedFilename(), 'kerf-damaged.txt');
  assert.equal(await readFile(await dl.path(), 'utf8'), 'hello');
  await page.waitForFunction(() => !document.getElementById('storeBar').textContent, null, { timeout: 3000 }).catch(() => assert.fail('the notice stays once the copy is saved'));
  await open(raw);
  assert.match(await notice(), /^Kerf couldn’t read everything/, 'a repaired project opens without a word');
  await page.click('#storeBar button >> text=Not now');
  assert.equal(await notice(), '');
  await open(saved(project('Fine', [])));
  assert.equal(await notice(), '', 'a good save says it was damaged');
}

// When Kerf can't save, a strip under the top bar says so until a save works, with a button to save the project as a
// file, and Projects stops saying projects are saved here. Storage full of other things: the edit isn't kept, and once
// there's room the next edit is. Storage blocked (cookies off): the strip is there from the start.
{
  const strip = () => page.evaluate(() => document.getElementById('storeBar').textContent);
  const pjNote = async win => { await win.click('#projBtn'); const t = await win.textContent('#pjNote'); await win.click('#pjx'); return t; };
  await open(null);
  assert.equal(await strip(), '', 'a strip about saving shows when saving works');
  assert.match(await pjNote(page), /^Projects are saved in this browser on this device\./);
  await page.evaluate(() => { let chunk = 'x'.repeat(1 << 20), n = 0; for (;;) { try { localStorage.setItem('filler' + n, chunk); n++; } catch (e) { if (chunk.length < 16) break; chunk = chunk.slice(0, chunk.length >> 1); } } });
  await page.fill('#pname', 'Too full to keep');
  await page.waitForFunction(() => document.getElementById('storeBar').textContent, null, { timeout: 3000 }).catch(() => assert.fail('a save that failed says nothing'));
  assert.match(await strip(), /^This browser’s storage is full, so the last change isn’t saved\. Save the project as a file\.Save as a file$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('kerf.v1')), null);
  assert.equal(await pjNote(page), 'Projects aren’t being saved in this browser right now.', 'Projects says it saved what it couldn’t');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#storeBar button')]);
  assert.equal(dl.suggestedFilename(), 'too-full-to-keep.kerf.json');
  assert.equal(JSON.parse(await readFile(await dl.path(), 'utf8')).project.name, 'Too full to keep');
  await page.evaluate(() => Object.keys(localStorage).forEach(k => { if (k.startsWith('filler')) localStorage.removeItem(k); }));
  await page.fill('#pname', 'Room again');
  await page.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('Room again'), null, { timeout: 3000 });
  assert.equal(await strip(), '', 'the strip stays after a save that worked');
  assert.match(await pjNote(page), /^Projects are saved in this browser/);

  const blocked = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }));
  try {
    const win = await blocked.newPage();
    win.on('pageerror', e => problems.push('blocked storage: ' + e.message));
    await win.goto(base);
    await win.waitForSelector('#planOut > *', { state: 'attached' });
    assert.equal(await win.textContent('#storeBar'), 'This browser isn’t letting Kerf save (private browsing or cookies blocked). Your changes last until you close this tab — save the project as a file to keep it.Save as a file');
    assert.equal(await pjNote(win), 'Projects aren’t being saved in this browser right now.');
    await win.fill('#pname', 'Kept in this tab');
    await win.waitForTimeout(600);
    assert.equal(await win.textContent('.total'), '$100.64', 'the page stops working with storage blocked');
    assert.match(await win.textContent('#storeBar'), /^This browser isn’t letting Kerf save/);
  } finally { await blocked.close(); }
}

// Every save carries the format's number (v). A page that finds a higher one, written by a newer Kerf in another
// window, neither repairs it, takes it in nor writes over it: it stops saving and asks for a reload. Whether it finds
// it at startup, from the other window's save as it happens, or just before writing its own.
{
  const strip = () => page.textContent('#storeBar');
  const reload = 'Kerf was updated in another window — reload to keep working.Reload';
  const leg = () => project('Shelves', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]);
  await open(null);
  await page.fill('#pname', 'Numbered');
  await page.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('Numbered'), null, { timeout: 3000 });
  assert.equal((await stored()).v, 1, 'a save has no format number');
  const p = leg(), newer = JSON.stringify({ ...saved(p), v: 99, projects: { [p.id]: { ...p, done: { [p.materials[0].id]: { key: 'x', ticks: { '0.0': 1700000000000 } } } } } });
  const unchanged = async what => {
    await page.fill('#pname', 'Edited in the older page');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => localStorage.getItem('kerf.v1')), newer, what + ': the older page wrote over a newer save');
    assert.equal(await page.evaluate(() => localStorage.getItem('kerf.v1.bad')), null, what + ': a newer save was kept as damaged');
    assert.equal(await strip(), reload, what + ': no strip asking for a reload');
  };
  await open(newer);
  assert.equal(await strip(), reload);
  await unchanged('at startup');
  await open(saved(leg()));
  await page.evaluate(t => { localStorage.setItem('kerf.v1', t); window.dispatchEvent(new StorageEvent('storage', { key: 'kerf.v1', newValue: t })); }, newer);
  await unchanged('from another window');
  await open(saved(leg()));
  await page.evaluate(t => localStorage.setItem('kerf.v1', t), newer);
  await unchanged('just before saving');
  await Promise.all([page.waitForNavigation(), page.click('#storeBar button >> text=Reload')]);
  await page.waitForSelector('#planOut > *', { state: 'attached' });
  assert.equal(await strip(), reload, 'the reload strip goes after a reload that didn’t help');
}

// Two windows opened on a first visit show one example between them: a tick in each used to leave two identical
// "Garage shelves (example)" projects, one made by each window. And when the example is the last project and is
// deleted, the new example it leaves shows in both windows, and stays, though it's newer than the deletion by
// less than a millisecond.
{
  await open(null);
  const other = await ctx.newPage();
  other.on('pageerror', e => problems.push('second window: ' + e.message));
  await other.goto(base);
  await other.waitForSelector('#planOut > *', { state: 'attached' });
  const examples = async () => Object.values((await stored()).projects).map(p => p.name);
  await view('saw');
  await other.click('#tabs button[data-t="saw"]');
  await page.locator('#sawOut .cut[data-k]').first().click();
  await page.waitForFunction(() => localStorage.getItem('kerf.v1'));
  await other.locator('#sawOut .cut[data-k]').nth(1).click();
  await other.waitForFunction(() => /"0\.1"/.test(localStorage.getItem('kerf.v1')));
  assert.deepEqual(await examples(), ['Garage shelves (example)'], 'two windows on a first visit made two examples');
  await other.click('#projBtn');
  assert.deepEqual(await other.$$eval('#sheet .pitem b', bs => bs.map(b => b.textContent)), ['Garage shelves (example)'], 'Projects lists the example twice');
  await other.click('#pjx');
  await page.waitForFunction(() => document.querySelector('.saw-bar b').textContent === '2 of 26 cuts', null, { timeout: 5000 })
    .catch(() => assert.fail('a tick in one window’s example doesn’t show in the other’s'));

  await page.click('#projBtn');
  await page.click('#sheet .btn.danger');
  await page.waitForTimeout(600);
  await page.click('#sheet .btn.danger');
  await other.waitForFunction(() => document.querySelector('.saw-bar b').textContent === '0 of 26 cuts', null, { timeout: 5000 })
    .catch(() => assert.fail('the new example doesn’t show in the other window'));
  assert.ok(!(await other.textContent('#toast')).includes('deleted in another window'), 'the other window took the new example as deleted');
  await other.locator('#sawOut .cut[data-k]').first().click();
  await page.waitForFunction(() => document.querySelector('.saw-bar b').textContent === '1 of 26 cuts', null, { timeout: 5000 })
    .catch(() => assert.fail('the new example went missing from the window that deleted the old one'));
  assert.deepEqual(await examples(), ['Garage shelves (example)'], 'the new example is missing from storage');
  await other.close();
}

// Two windows open at once keep each other's work: a project added in one isn't undone when the other saves, nor
// brought back once deleted, a tick in one and an edit in the other are both kept, and an edit still waiting to
// be saved isn't lost when the other window saves.
{
  const shelves = project('Shelves', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]);
  await open(saved(shelves));
  const other = await ctx.newPage();
  other.on('pageerror', e => problems.push('second window: ' + e.message));
  await other.goto(base);
  await other.waitForSelector('#planOut > *', { state: 'attached' });
  const names = async () => Object.values((await stored()).projects).map(p => p.name).sort();
  const storedHas = (win, text) => win.waitForFunction(t => (localStorage.getItem('kerf.v1') || '').includes(t), text, { timeout: 5000 });

  await other.click('#projBtn');
  await other.click('#pjNew');
  await other.fill('#pname', 'Bench');
  await storedHas(other, 'Bench');
  await page.fill('#pname', 'Garage shelves');
  await storedHas(page, 'Garage shelves');
  assert.deepEqual(await names(), ['Bench', 'Garage shelves'], 'a save in one window undid a project added in the other');
  await page.click('#projBtn');
  assert.deepEqual(await page.$$eval('#sheet .pitem b', bs => bs.map(b => b.textContent).sort()), ['Bench', 'Garage shelves'], 'Projects doesn’t show the other window’s project');
  await page.click('#pjx');

  await other.click('#projBtn');
  await other.click('#sheet .btn.danger');
  await other.waitForTimeout(600);
  await other.click('#sheet .btn.danger');
  await other.waitForFunction(() => !localStorage.getItem('kerf.v1').includes('Bench'));
  await page.fill('#pname', 'Garage shelves 2');
  await storedHas(page, 'Garage shelves 2');
  assert.deepEqual(await names(), ['Garage shelves 2'], 'a project deleted in one window came back from the other');

  await view('saw');
  await other.click('#tabs button[data-t="saw"]');
  await other.locator('#sawOut .cut[data-k]').first().click();
  await page.waitForFunction(() => document.querySelector('.saw-bar b').textContent === '1 of 2 cuts', null, { timeout: 5000 })
    .catch(() => assert.fail('a tick in one window doesn’t show in the other'));
  await page.fill('#pname', 'Garage shelves 3');
  await storedHas(page, 'Garage shelves 3');
  const kept = (await stored()).projects[shelves.id];
  assert.deepEqual([kept.name, kept.done[shelves.materials[0].id].ticks], ['Garage shelves 3', { '0.0': 1 }], 'an edit in one window undid a tick in the other');

  // Another window's save arriving while an edit here waits for typing to stop (written and announced at once).
  await page.waitForTimeout(600);
  await other.close();
  const waiting = await page.evaluate(() => {
    const i = document.getElementById('pname'); i.value = 'Typed just now'; i.dispatchEvent(new Event('input', { bubbles: true }));
    const db = JSON.parse(localStorage.getItem('kerf.v1'));
    db.projects.desk = { id: 'desk', name: 'Desk', units: 'in', kerf: 0.125, trim: 0, keep: 12, cur: '$', updated: Date.now() - 1000, materials: [], done: {} };
    db.order.unshift('desk');
    const text = JSON.stringify(db);
    localStorage.setItem('kerf.v1', text);
    window.dispatchEvent(new StorageEvent('storage', { key: 'kerf.v1', newValue: text }));
    return !localStorage.getItem('kerf.v1').includes('Typed just now');
  });
  assert.ok(waiting, 'the edit was saved before the other window’s save arrived');
  await storedHas(page, 'Typed just now');
  assert.deepEqual(await names(), ['Desk', 'Typed just now'], 'an edit waiting to be saved was lost when another window saved');
}

// On a phone the cut list fits: a part takes two lines, its name across the top, so names, lengths and prices
// aren't cut short, nothing scrolls sideways, every field's text is 16px (iOS zooms the page into a smaller one), and
// the controls are 44px tall. Checked on the example and on materials with longer names, at 320 and 390 wide.
{
  const long = project('Mudroom bench', [
    { ...board('1×6 board — pine', [{ len: 72, price: 6.28 }, { len: 96, price: 8.28 }, { len: 30, have: 2 }],
      [{ name: 'Seat slat, rounded', qty: 5, len: 46 }, { name: 'Shiplap backer board', qty: 9, len: 47.5 }, { name: 'Cubby divider', qty: 4, len: 143.9375 }]), note: '¾ × 5½ in' },
    { ...sheet('¾ plywood', [{ len: 96, wid: 48, price: 134.5 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }],
      [{ name: 'Cubby side, left', qty: 2, len: 34.5, wid: 15.25 }, { name: 'Back', qty: 1, len: 47.9375, wid: 34.5, grain: false }]), note: '23/32 in actual' }]);
  const clipped = () => page.evaluate(() => { document.querySelectorAll('details.stock').forEach(d => { d.open = true; }); return [...document.querySelectorAll('#mats input')].filter(i => i.scrollWidth > i.clientWidth).map(i => i.value); });
  for (const [width, height] of [[320, 568], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const db of [null, saved(long)]) {
      await open(db);
      await view('list');
      assert.deepEqual(await clipped(), [], `fields cut short at ${width} wide`);
      await fitsPhone(`cut list at ${width} wide`);
    }
  }
  // The text in every field is 16px or more, in the cut list and in the dialogs.
  const small = sel => page.$$eval(sel, els => els.filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.dataset.f || e.id || e.tagName));
  assert.deepEqual(await small('#mats input, #mats select, #pnotes'), [], 'fields in the cut list under 16px');
  for (const [btn, done] of [['#setBtn', '#stx'], ['#projBtn', '#pjx']]) {
    await page.click(btn);
    assert.deepEqual(await small('#sheet input:not([type=file]), #sheet select, #sheet textarea'), [], 'fields in a dialog under 16px');
    await page.click(done);
  }
  // Controls are 44px tall, and the grain lock sits at least 8px from the ✕ next to it.
  const short = sel => page.$$eval(sel, els => els.filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.dataset.f || e.dataset.a || e.textContent));
  assert.deepEqual(await short('#mats .prow .grain, #mats .icon, #mats input, #mats select, #mats .addpart, #mats .lbtn, #mats .pbtn, #tabs button, .top .tbtn'), [], 'cut list controls under 44px tall');
  assert.ok(await page.$eval('.sheetmat .prow[data-pid]', r => r.querySelector('[data-a="delpart"]').getBoundingClientRect().left - r.querySelector('.grain').getBoundingClientRect().right >= 8), 'the grain lock is less than 8px from the ✕');
  await page.click('#setBtn');
  assert.deepEqual(await short('#sheet button, #sheet input'), [], 'Settings controls under 44px tall');
  await page.click('#stx');
  // A touch tablet gets them too, upright or on its side: it had 30px ✕ and grain locks, with every 44px rule kept for
  // phone widths. On its side the cut list is a column beside the plan, so its parts take two lines there, as on a phone,
  // leaving the name room.
  for (const [width, height] of [[768, 1024], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await open(saved(long));
    if (width < 960) await view('list');
    assert.deepEqual(await short('#mats .prow .grain, #mats .icon, #mats input, #mats select, #mats .addpart, #mats .lbtn, #mats .pbtn, #tabs button, .top .tbtn'), [], `cut list controls under 44px tall on a ${width} wide tablet`);
    assert.ok(await page.$eval('.sheetmat .prow[data-pid]', r => r.querySelector('[data-a="delpart"]').getBoundingClientRect().left - r.querySelector('.grain').getBoundingClientRect().right >= 8), `the grain lock is less than 8px from the ✕ at ${width} wide`);
    assert.ok(await page.$$eval('#mats .prow[data-pid] [data-f="pname"]', is => is.every(i => i.getBoundingClientRect().width >= 150)), `a part’s name has no room at ${width} wide`);
    await fitsPhone(`cut list on a ${width} wide tablet`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  assert.deepEqual(await short('#planOut button'), [], 'plan buttons under 44px tall');
  // Nothing scrolls sideways on a tablet or a laptop either.
  for (const [width, height] of [[768, 1024], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    for (const t of ['list', 'plan']) { await page.evaluate(t => document.querySelector(`#tabs button[data-t="${t}"]`).click(), t); await fitsPhone(`${t} at ${width} wide`); }
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// On a phone with a notch the page keeps clear of it: the side gutters widen to the safe area, and the top bar sits
// at the very top with its own background under the status bar, so nothing scrolls past above it.
{
  const cdp = await page.context().newCDPSession(page);
  const insets = i => cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0, ...i } });
  await open(null);
  await page.setViewportSize({ width: 844, height: 390 });
  await insets({ left: 47, right: 47, bottom: 21 });
  await view('list');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.brand, #mats .icon, #mats .plet, .tbtn:not([hidden])')].every(e => { const r = e.getBoundingClientRect(); return r.left >= 47 && r.right <= innerWidth - 47; })), 'something sits in the notch');
  await page.setViewportSize({ width: 390, height: 844 });
  await insets({ top: 47, bottom: 34 });
  await page.evaluate(() => scrollTo(0, 400));
  assert.deepEqual(await page.evaluate(() => { const t = document.querySelector('.top'); return [t.getBoundingClientRect().top, getComputedStyle(t).paddingTop]; }), [0, '57px'], 'a strip shows above the top bar');
  await cdp.send('Emulation.clearSafeAreaInsetsOverride').catch(() => insets({}));
  await cdp.detach();
}

// The cut list says how to type lengths on a phone too, where the pane's heading is left out for its tab.
await open(null);
await view('list');
assert.ok(await page.isVisible('#unitNote'), 'a phone isn’t told how to type lengths');
assert.equal(await page.textContent('#unitNote'), 'Lengths in inches — 35 3/4, 2\' 11 3/4", 910mm all work');

// Kerf remembers, in this browser, the last prices you set for each kind on the Add material list, and a new one starts
// at them. One that starts at the examples says so under its sizes until a price is changed, as the example project's
// do; the line hides while the drawer is open.
{
  await open(saved(project('Bookcase', [])));
  await view('list');
  const eg = i => page.$$eval('#mats .mat', (ms, i) => { const e = ms[i].querySelector('details.stock .eg'); return e && e.getClientRects().length ? e.textContent : null; }, i);
  const prices = i => page.$$eval('#mats .mat', (ms, i) => [...ms[i].querySelectorAll('.srow[data-sid] [data-f="price"]')].map(f => f.value), i);
  await page.click('.pbtn:text-is("2×4")');
  assert.equal(await eg(0), 'Example prices — tap to set yours', 'a new 2×4 doesn’t say its prices are examples');
  assert.deepEqual(await prices(0), ['4.28', '6.38', '7.68', '10.98']);
  await page.click('#mats .mat >> nth=0 >> details.stock summary');
  assert.equal(await eg(0), null, 'the line about example prices shows in the open drawer');
  await page.fill('#mats .mat >> nth=0 >> .srow[data-sid] [data-f="price"] >> nth=0', '3.98');
  await page.fill('#mats .mat >> nth=0 >> .srow[data-sid] [data-f="price"] >> nth=1', '5,97');
  await page.click('#mats .mat >> nth=0 >> details.stock summary');
  assert.equal(await eg(0), null, 'a 2×4 with its prices set still says they’re examples');
  await page.waitForFunction(() => !(localStorage.getItem('kerf.v1') || '').includes('examplePrices'), null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kerf.prices'))), { 'in board 2×4': { 96: 3.98, 120: 5.97, 144: 7.68, 192: 10.98 } });
  // The next 2×4 starts at them, in this project and a new one; a 2×6 still starts at the examples.
  await page.click('.pbtn:text-is("2×4")');
  assert.deepEqual(await prices(1), ['3.98', '5.97', '7.68', '10.98'], 'a new 2×4 doesn’t start at the prices set last');
  assert.equal(await eg(1), null, 'a 2×4 at your prices says they’re examples');
  await page.click('.pbtn:text-is("2×6")');
  assert.equal(await eg(2), 'Example prices — tap to set yours');
  await page.click('#projBtn');
  await page.click('#pjNew');
  await view('list');
  await page.click('.pbtn:text-is("2×4")');
  assert.deepEqual(await prices(0), ['3.98', '5.97', '7.68', '10.98'], 'a 2×4 in a new project doesn’t start at the prices set last');
  // A sheet is remembered by its size.
  await page.click('.pbtn:text-is("¾ plywood")');
  await page.click('#mats .mat >> nth=1 >> details.stock summary');
  await page.fill('#mats .mat >> nth=1 >> .srow[data-sid] [data-f="price"] >> nth=0', '52');
  await page.click('.pbtn:text-is("¾ plywood")');
  assert.deepEqual(await prices(2), ['52.00', '34.00', '21.00']);
  // A price cleared to type again isn't remembered, so the next one doesn't start with that size free.
  await page.fill('#mats .mat >> nth=1 >> .srow[data-sid] [data-f="price"] >> nth=0', '');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('kerf.prices'))))['in sheet ¾ plywood']['96x48'], 52, 'a price cleared was remembered as free');
  // Other board starts at made-up prices and says so; the example project's materials say so too.
  await page.click('.pbtn >> text=Other board');
  assert.equal(await eg(3), 'Example prices — tap to set yours');
  await open(null);
  await view('list');
  assert.deepEqual([await eg(0), await eg(1)], ['Example prices — tap to set yours', 'Example prices — tap to set yours'], 'the example project’s prices aren’t said to be examples');
}

// Face-frame stock is a preset, and a material not on the list ('Other board') is named first: its name is selected.
await open(saved(project('Bookcase', [])));
await view('list');
await page.click('.pbtn >> text=1×2 board');
assert.equal(await page.textContent('.mat .mat-note'), '¾ × 1½ in');
assert.match(await page.textContent('details.stock .chips'), /6′ · \$2\.38.*8′ · \$2\.98/);
await page.click('.pbtn >> text=Other board');
await page.keyboard.type('Poplar 1×5');
assert.deepEqual(await page.$$eval('#mats .mat-name', is => is.map(i => i.value)), ['1×2 board', 'Poplar 1×5'], 'Other board doesn’t start on its name');
// Enter on its name goes on to its first part, added for it, with the keyboard saying Next; and on the 1×2's name, to
// the part it has. The project's name says Done and Enter closes the keyboard. In Settings Enter goes from the kerf
// to trim, keep and the currency, then closes the keyboard, leaving focus in the dialog.
{
  const focused = () => page.evaluate(() => { const a = document.activeElement, r = a.closest('.mat'); return (a.dataset.f || a.id || a.className) + (r ? ' in ' + r.querySelector('.mat-name').value : ''); });
  assert.equal(await page.getAttribute('#mats .mat-name >> nth=1', 'enterkeyhint'), 'next');
  await page.keyboard.press('Enter');
  assert.equal(await focused(), 'pname in Poplar 1×5', 'Enter on a new material’s name doesn’t go to a part');
  assert.equal(await page.locator('#mats .mat >> nth=1').locator('.prow[data-pid]').count(), 1, 'Enter on the name didn’t add one part');
  await page.keyboard.type('Rail');
  await page.focus('#mats .mat-name >> nth=0');
  await page.keyboard.press('Enter');
  assert.equal(await focused(), 'pname in 1×2 board', 'Enter on a material’s name doesn’t go to its first part');
  assert.equal(await page.locator('#mats .mat >> nth=0').locator('.prow[data-pid]').count(), 1, 'Enter on the name added a part to a material that has one');
  assert.equal(await page.getAttribute('#pname', 'enterkeyhint'), 'done');
  await page.focus('#pname');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'Enter on the project name doesn’t close the keyboard');
  await page.click('#setBtn');
  assert.deepEqual(await page.$$eval('#sKerf, #sTrim, #sEdge, #sKeep, #sCur', is => is.map(i => i.getAttribute('enterkeyhint'))), ['next', 'next', 'next', 'next', 'done']);
  await page.focus('#sKerf');
  const steps = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Enter'); steps.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className)); }
  assert.deepEqual(steps, ['sTrim', 'sEdge', 'sKeep', 'sCur', 'sheet'], 'Enter doesn’t go along Settings');
  await page.click('#stx');
}
// Plywood's note and the Settings note typeset their fractions, as the plan does: '23/32 in actual' stood beside
// '1½ × 3½ in', and the Settings note's ⅛ came from another font (Barlow has no ⅛), next to an ASCII 3/32″.
await page.click('.pbtn >> text=¾ plywood');
assert.deepEqual(await page.$eval('.sheetmat .mat-note', n => [n.querySelector('.fr .sr')?.textContent, n.querySelector('[aria-hidden]')?.textContent]), ['23/32', '23⁄32'], 'plywood’s note doesn’t typeset 23/32');
await page.click('#setBtn');
{
  const note = await page.$eval('#sheet .note', n => ({ text: n.textContent, fr: [...n.querySelectorAll('.fr .sr')].map(s => s.textContent) }));
  assert.ok(!/⅛/.test(note.text) && note.text.includes('3\u00a0mm'), 'the Settings note: ' + note.text);
  assert.deepEqual(note.fr, ['1/8', '3/32', '1/16', '1/4'], 'the Settings note’s fractions aren’t typeset');
}
await page.click('#stx');

// A three-letter currency sits clear of the price, and a price typed over an old one isn't read as both.
{
  await open(saved(project('Franken', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }], [{ name: 'Shelf', qty: 2, len: 30, wid: 12 }])], { cur: 'CHF' })));
  await view('list');
  await page.click('details.stock summary');
  assert.ok(await page.$eval('.srow[data-sid] .money', m => m.querySelector('span').getBoundingClientRect().right <= m.querySelector('input').getBoundingClientRect().left + parseFloat(getComputedStyle(m.querySelector('input')).paddingLeft)), 'CHF covers the price');
  const price = page.locator('.srow[data-sid] input[data-f="price"]').nth(1);
  await price.fill('3439.98.00');
  assert.ok(await price.evaluate(e => e.classList.contains('bad')), 'a price with two decimal points isn’t marked');
  assert.doesNotMatch(await page.textContent('details.stock .chips'), /3439/, 'a price with two decimal points was read as a price');
  // Tapping a count, a price or a stock length selects it, so what's typed replaces it (a part's name and length don't).
  for (const [field, typed] of [['.prow[data-pid] input[data-f="qty"]', '3'], ['.srow[data-sid] input[data-f="price"]', '39.98'], ['.srow[data-sid] input[data-f="slen"]', '50']]) {
    await page.locator(field).first().tap();
    await page.waitForTimeout(50);
    await page.keyboard.type(typed);
    assert.equal(await page.locator(field).first().inputValue(), typed, `typing into a tapped ${field} added to what was there`);
  }
}

// Rows pasted into a part's name from a spreadsheet (a tab between cells) come in as parts: name, count, length and
// width, after the part pasted into, or in its place while it's blank. A first row naming the columns says which is
// which. The toast's Undo takes them out again, and puts back the blank part. One plain line is pasted as a name.
{
  const pasteInto = (sel, text) => page.evaluate(([sel, t]) => {
    document.getElementById('toast').classList.remove('show');
    const data = new DataTransfer(); data.setData('text/plain', t);
    const el = document.querySelector(sel); el.focus();
    return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [sel, text]);
  const rows = m => page.$$eval(`#mats .mat:nth-of-type(${m}) .prow[data-pid]`, rs => rs.map(r => [...r.querySelectorAll('input')].filter(i => i.getClientRects().length).map(i => i.value).join(' / ')));
  await open(saved(project('Cabinet', [
    board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 4, len: 30 }]),
    sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: '', qty: 1, len: 0, wid: 0, grain: false }])])));
  await view('list');
  // Into a board part that has a name: after it, with the count first as some sheets have it.
  await pasteInto('#mats .mat:nth-of-type(1) .prow[data-pid] [data-f="pname"]', '2\tRail\t21 1/2\n3\tStretcher\t18-3/4"\n');
  assert.deepEqual(await rows(1), ['Leg / 4 / 30"', 'Rail / 2 / 21 1/2"', 'Stretcher / 3 / 18 3/4"'], 'rows pasted into a board part');
  assert.equal(await page.textContent('#toast'), 'Added 2 partsUndo');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'Stretcher', 'focus isn’t on the last part pasted');
  // Into the blank sheet part, with a row naming the columns in another order: it takes the blank part's place.
  await pasteInto('#mats .mat:nth-of-type(2) .prow[data-pid] [data-f="pname"]', 'Width (in)\tLength (in)\tQty\tPart\r\n11.25\t34.5\t2\tSide\r\n11\t"33,0"\t\tShelf\r\n');
  assert.deepEqual(await rows(2), ['Side / 2 / 34 1/2" / 11 1/4"', 'Shelf / 1 / 33" / 11"'], 'rows pasted into a blank sheet part');
  await page.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('"Shelf"'), null, { timeout: 5000 });
  const ply = (await stored()).projects[(await stored()).current].materials[1].parts;
  assert.deepEqual(ply.map(p => [p.name, p.qty, p.len, p.wid, p.grain]), [['Side', 2, 34.5, 11.25, false], ['Shelf', 1, 33, 11, false]], 'pasted sheet parts take the grain of the part pasted into');
  assert.match(await page.textContent('.total'), /^\$/);
  await page.click('#toast button');
  assert.deepEqual(await rows(2), [' / 1 /  / '], 'Undo didn’t put back the blank part');
  assert.deepEqual(await rows(1), ['Leg / 4 / 30"', 'Rail / 2 / 21 1/2"', 'Stretcher / 3 / 18 3/4"'], 'Undo took out another material’s parts');
  // A single line with no tab is a name, pasted as usual.
  assert.equal(await pasteInto('#mats .mat:nth-of-type(1) .prow[data-pid] [data-f="pname"]', 'Long leg'), true, 'a name pasted as a name was taken over');
  assert.equal((await rows(1)).length, 3);
  // A name that starts with a digit is a name, with the count before it.
  await pasteInto('#mats .mat:nth-of-type(1) .prow[data-pid] [data-f="pname"]', '2\t1st shelf cleat\t10\n');
  assert.equal((await rows(1))[1], '1st shelf cleat / 2 / 10"', 'a name starting with a digit was read as a count');
}

// On a touch screen an inch length takes the number pad, and while it has focus a row of keys above the keyboard types
// ⅛ to ⅞, ′ and ″, which Kerf reads (70¾″ is 70 3/4"), keeping the focus in the field. Its last key swaps the field to
// the letter keyboard and back. The row sits on the visual viewport's bottom edge, the top of a phone's keyboard, with
// the field kept in sight above it. Not for a part's name, a project in mm, or a laptop with no touch screen.
{
  await open(null);
  await view('list');
  const len = '#mats .prow[data-pid] [data-f="len"] >> nth=0', focused = () => page.evaluate(() => document.activeElement.dataset.f || document.activeElement.id);
  assert.equal(await page.getAttribute(len, 'inputmode'), 'decimal', 'an inch length doesn’t take the number pad on a phone');
  assert.ok(await page.isHidden('#fbar'));
  await page.fill(len, '70');
  assert.ok(await page.isVisible('#fbar'), 'no fraction keys while an inch length has focus');
  assert.deepEqual(await page.$$eval('#fbar button', bs => bs.map(b => b.textContent)), ['1/8⅛', '1/4¼', '3/8⅜', '1/2½', '5/8⅝', '3/4¾', '7/8⅞', '′', '″', 'abc'].map(t => t.replace(/^(\d)\/(\d)(.)$/, (m, n, d) => n + '/' + d + n + '⁄' + d)));
  await page.click('#fbar [data-k="¾"]');
  await page.click('#fbar [data-k="″"]');
  assert.equal(await page.inputValue(len), '70¾″');
  assert.equal(await focused(), 'len', 'a fraction key took the focus from the field');
  await page.waitForFunction(() => { const d = JSON.parse(localStorage.getItem('kerf.v1') || 'null'); return d && d.projects[d.current].materials[0].parts[0].len === 70.75; }, null, { timeout: 5000 });
  const bar = await page.$eval('#fbar', b => b.getBoundingClientRect().bottom);
  assert.ok(Math.abs(bar - 844) < 1, `the fraction keys aren’t at the bottom of the screen: ${bar}`);
  // The letter keyboard, for a sixteenth; and back.
  await page.click('#fbar .abc');
  assert.deepEqual([await focused(), await page.getAttribute(len, 'inputmode'), await page.textContent('#fbar .abc'), await page.isVisible('#fbar')], ['len', 'text', '123', true], 'the letter keyboard key');
  await page.click('#fbar .abc');
  assert.deepEqual([await focused(), await page.getAttribute(len, 'inputmode')], ['len', 'decimal']);
  // Leaving the field puts the keys away, and the length reads as a tape does.
  await page.click('#mats [data-f="pname"] >> nth=0');
  assert.ok(await page.isHidden('#fbar'), 'fraction keys for a part’s name');
  assert.equal(await page.inputValue(len), '70 3/4"');
  // A fraction typed at the end of a length shown with its inch mark (48") goes before the mark.
  const rail = '#mats .prow[data-pid] [data-f="len"] >> nth=1';
  await page.click(rail);
  await page.keyboard.press('End');
  await page.click('#fbar [data-k="⅞"]');
  assert.equal(await page.inputValue(rail), '48⅞″', 'a fraction after the inch mark');
  assert.equal(await page.locator(rail).evaluate(i => i.classList.contains('bad')), false, '48⅞″ isn’t read as a length');
  // A sixteenth typed on the letter keyboard after a length: the swap leaves the length without its inch mark (the blur
  // wrote 35"), so 35 15/16 reads.
  await page.fill(rail, '35');
  await page.click('#fbar .abc');
  assert.equal(await page.inputValue(rail), '35', 'the letter keyboard key left the inch mark on the length');
  await page.keyboard.type(' 15/16');
  assert.equal(await page.locator(rail).evaluate(i => i.classList.contains('bad')), false, '35 15/16 typed after the letter keyboard key isn’t read');
  await page.waitForFunction(() => { const d = JSON.parse(localStorage.getItem('kerf.v1') || 'null'); return d && d.projects[d.current].materials[0].parts[1].len === 35.9375; }, null, { timeout: 5000 }).catch(() => assert.fail('35 15/16 wasn’t kept'));
  await page.click('#fbar .abc');
  // With the keyboard up (a visual viewport 500 px tall), the keys sit on top of it and the field stays above them.
  await page.evaluate(() => { const vv = new EventTarget(); Object.assign(vv, { offsetTop: 0, height: 500, width: 390 }); Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv }); });
  await page.evaluate(() => { document.querySelector('.sheetmat .prow[data-pid] [data-f="wid"]').scrollIntoView({ block: 'end' }); document.querySelector('.sheetmat .prow[data-pid] [data-f="wid"]').focus(); });
  assert.deepEqual(await page.evaluate(() => [Math.round(document.getElementById('fbar').getBoundingClientRect().bottom), Math.round(document.getElementById('fbar').getBoundingClientRect().top - document.activeElement.getBoundingClientRect().bottom) >= 0]), [500, true], 'the fraction keys aren’t on top of the keyboard, below the field');
  // A board's sizes to buy take ′.
  await page.click('#mats .mat >> nth=0 >> details.stock summary');
  await page.click('#mats .mat >> nth=0 >> .srow[data-sid] [data-f="slen"] >> nth=0'); // a tap selects it, to type over
  await page.waitForFunction(() => document.activeElement.selectionEnd - document.activeElement.selectionStart === 2);
  await page.keyboard.type('9');
  await page.click('#fbar [data-k="′"]');
  assert.equal(await page.inputValue('#mats .mat >> nth=0 >> .srow[data-sid] [data-f="slen"] >> nth=0'), '9′');
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForSelector('#fbar', { state: 'hidden', timeout: 2000 }).catch(() => assert.fail('the fraction keys stay once the field is left'));
  // Not in mm, nor on a laptop.
  await open(saved(project('Metric', [board('45×90', [{ len: 94.488, price: 6.5 }], [{ name: 'Post', qty: 2, len: 35 }])], { units: 'mm' })));
  await view('list');
  await page.click(len);
  assert.ok(await page.isHidden('#fbar'), 'fraction keys in a project in mm');
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const lp = await laptop.newPage();
    lp.on('pageerror', e => problems.push('laptop: ' + e.message));
    await lp.goto(base);
    await lp.waitForSelector('#planOut > *', { state: 'attached' });
    await lp.click(len);
    assert.deepEqual([await lp.isHidden('#fbar'), await lp.getAttribute(len, 'inputmode')], [true, null], 'fraction keys or the number pad on a laptop');
  } finally { await laptop.close(); }
}

// Enter goes along a part, name, count, length (and width), then on to the next part's name; from the last part it
// adds one only once that part has its size, so it never leaves two blank parts.
{
  await open(saved(project('Cabinet', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Adjustable shelf', qty: 3, len: 28.5, wid: 11.25 }, { name: 'Left side panel', qty: 2, len: 34.5, wid: 23.25 }]),
    board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 4, len: 30 }])])));
  await view('list');
  const at = () => page.evaluate(() => { const e = document.activeElement; return e.dataset.f + ':' + e.value; });
  const field = (f, i) => page.locator(`.sheetmat .prow[data-pid] input[data-f="${f}"]`).nth(i);
  assert.equal(await field('pname', 0).getAttribute('enterkeyhint'), 'next');
  await field('pname', 0).focus();
  const walk = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); walk.push(await at()); }
  assert.deepEqual(walk, ['qty:3', 'len:28 1/2"', 'wid:11 1/4"', 'pname:Left side panel'], 'Enter doesn’t walk along the part');
  const rows = () => page.locator('.mat:not(.sheetmat) .prow[data-pid]').count();
  await page.click('.mat:not(.sheetmat) [data-a="addpart"]');
  assert.equal(await rows(), 2);
  await page.keyboard.type('Apron');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  assert.equal(await at(), 'len:', 'Enter on the count doesn’t go to the length');
  await page.keyboard.press('Enter');
  assert.deepEqual([await rows(), await at()], [2, 'len:'], 'Enter on a part with no length added another');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  assert.deepEqual([await rows(), await at()], [3, 'pname:'], 'Enter after the length doesn’t add the next part');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
  assert.equal(await rows(), 3, 'Enter on a blank part added a second blank part');
  // (a board with no width shows no width for its parts)
  assert.deepEqual(await page.$$eval('.mat:not(.sheetmat) .prow[data-pid]', rs => rs.map(r => [...r.querySelectorAll('input')].filter(i => i.getClientRects().length).map(i => i.value).join('|'))), ['Leg|4|30"', 'Apron|2|20"', '|1|']);
  // A blank part's length (and a sheet part's width) shows an example of how to type it.
  assert.deepEqual(await page.$$eval('.prow[data-pid] input', is => [...new Set(is.filter(i => i.getClientRects().length).map(i => i.dataset.f + ':' + i.placeholder))]), ['pname:Part', 'qty:', 'len:35 3/4', 'wid:16'], 'a length field’s example is broken');
  // In the sizes to buy, Enter goes on to the next field.
  await page.click('.sheetmat details.stock summary');
  await page.locator('.sheetmat .srow[data-sid] input[data-f="slen"]').focus();
  const steps = [];
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Enter'); steps.push(await at()); }
  assert.deepEqual(steps, ['swid:48"', 'price:58.00'], 'Enter doesn’t go along a size to buy');
  // A field the keyboard moves to comes out from under the sticky top bar.
  const name = page.locator('.mat:not(.sheetmat) .prow[data-pid] input[data-f="pname"]').first();
  await name.evaluate(e => scrollBy(0, e.getBoundingClientRect().top - 40));
  await name.evaluate(e => e.focus());
  assert.ok(await name.evaluate(e => e.getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom), 'a focused field is under the top bar');
}

// Each view keeps its own place: the plan opens at the top the first time, and the cut list comes back where it was.
// New project opens on the cut list, and an empty plan has a button to it.
{
  // (tapped in the page: Playwright's own click scrolls the page to the top first, to reach the sticky tabs)
  const tab = t => page.$eval(`#tabs button[data-t="${t}"]`, b => b.click());
  await open(null);
  await tab('list');
  await page.evaluate(() => { document.querySelectorAll('details.stock').forEach(d => { d.open = true; }); scrollTo(0, 300); });
  await tab('plan');
  assert.equal(await page.evaluate(() => scrollY), 0, 'the plan opened where the cut list was scrolled to');
  await page.evaluate(() => scrollTo(0, 700));
  await tab('list');
  assert.equal(await page.evaluate(() => scrollY), 300, 'the cut list didn’t come back where it was');
  await tab('plan');
  assert.equal(await page.evaluate(() => scrollY), 700, 'the plan didn’t come back where it was');
  await page.evaluate(() => scrollTo(0, 0));
  await page.click('#exNew');
  assert.equal(await page.getAttribute('#app', 'data-tab'), 'list', 'New project doesn’t open on the cut list');
  await view('plan');
  await page.click('#planOut .empty button');
  assert.equal(await page.getAttribute('#app', 'data-tab'), 'list', 'the empty plan’s button doesn’t go to the cut list');
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.ok(await page.isHidden('#planOut .empty button'), 'the empty plan shows a button to the cut list beside it');
  await page.setViewportSize({ width: 390, height: 844 });
}

// A plan edited from the cut list on a phone is drawn once it shows, at its own width, whether by its tab or by the
// window widening to show both, and never left as it was before the edit.
{
  await open(saved({ ...project('Shelf', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]) }));
  await view('list');
  await page.fill('.prow[data-pid] input[data-f="len"]', '40');
  await page.waitForTimeout(600);
  await view('plan');
  const drawn = () => page.evaluate(() => { const s = document.querySelector('#planOut svg.diag'); return [s.getAttribute('viewBox').split(' ')[2] == Math.max(260, document.getElementById('planOut').clientWidth - 26), document.querySelector('#planOut .steps').textContent]; });
  assert.deepEqual(await drawn(), [true, 'ALeg · 2 × 40″'], 'the plan isn’t drawn anew for its tab');
  await view('list');
  await page.fill('.prow[data-pid] input[data-f="len"]', '35');
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(50);
  assert.deepEqual(await drawn(), [true, 'ALeg · 2 × 35″'], 'widening the window shows the plan from before the edit');
  await page.setViewportSize({ width: 390, height: 844 });
}

// The Source menu offers every count on hand from 1 to 10, the range a planner link can carry.
await open(saved(project('Offcuts', [board('2×4', [{ len: 96, price: 4.28 }, { len: 40, have: 7 }], [{ name: 'Leg', qty: 2, len: 30 }])])));
await view('list');
await page.click('details.stock summary');
const source = page.locator('.srow[data-sid] select').nth(1);
assert.equal(await source.inputValue(), '7', 'seven on hand shows as Buy');
assert.deepEqual(await source.locator('option').evaluateAll(os => os.map(o => o.value)), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

// Have 2 on a size to buy: the toast counts what you have, in words that read right for any count.
{
  await open(saved(project('Two on hand', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])])));
  await view('list');
  await page.click('details.stock summary');
  await page.selectOption('.srow[data-sid] select >> nth=0', '2');
  assert.equal(await page.textContent('#toast'), 'Kerf will use the 2 you have first, and buy more if it needs them');
}

// "Have 1" on a size you buy means you own one: Kerf uses it and still buys that size. Six 72" sides need two 4×8
// sheets, and with one on hand the plan buys the other, where it used to drop the plywood from the plan.
{
  await open(saved(project('On hand', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }], [{ name: 'Side', qty: 6, len: 72, wid: 11.25 }])])));
  assert.equal(await page.textContent('.total'), '$116.00');
  assert.equal(await page.locator('.proved').count(), 0, 'a sheet plan says it’s the cheapest possible');
  await view('list');
  await page.click('details.stock summary');
  await page.selectOption('.srow[data-sid] select >> nth=0', '1');
  assert.equal(await page.textContent('#toast'), 'Kerf will use the 4′ × 8′ you have first, and buy more if it needs them');
  assert.deepEqual(await page.$$eval('.srow[data-sid]', rs => rs.map(r => r.querySelector('[data-f="slen"]').value + ' ' + r.querySelector('[data-f="price"]').value + ' ' + r.querySelector('select').value)),
    ['96"  1', '96" 58.00 0', '48" 34.00 0', '48" 21.00 0'], 'the sizes after "Have 1": yours, then the same size to buy');
  // Another Have on a size that's still bought adds nothing more.
  await page.selectOption('.srow[data-sid] select >> nth=0', '2');
  assert.equal(await page.locator('.srow[data-sid]').count(), 4);
  await page.selectOption('.srow[data-sid] select >> nth=0', '1');
  assert.equal(await page.isHidden('.perr'), true, 'the cut list says parts are left out');
  await view('plan');
  await page.waitForFunction(() => document.querySelector('.total').textContent === '$58.00', null, { timeout: 5000 }).catch(() => {});
  assert.equal(await page.textContent('.total'), '$58.00');
  assert.deepEqual(await page.$$eval('.shop tbody tr:not(.grp)', rs => rs.map(r => r.textContent)), ['1 ×48″ × 96″$58.00$58.00', '1 ×48″ × 96″ (yours)—free']);
  // Without a 4×8 to buy, the four sides that fit on the sheet you have are planned, and the cut list and the plan say
  // which are left out.
  await view('list');
  await page.click('.srow[data-sid] >> nth=1 >> [data-a="delstock"]');
  await page.waitForFunction(() => !document.querySelector('.perr').hidden, null, { timeout: 5000 });
  assert.equal(await page.textContent('.perr'), 'The sheets you have can’t hold every part: Side × 2 (72″ × 11\u00a01/4″) are left out of the plan. Add a size to buy that fits them.');
  await view('plan');
  assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¾ plywood: the sheets you have can’t hold Side × 2, so add a size to buy — see the cut list.');
  assert.equal(await page.textContent('.total'), '$0.00');
  assert.equal(await page.textContent('#planOut .mdiag h4'), '¾ plywood, 1 sheet');
  // "see the cut list" opens the material's sizes, to add one to buy.
  await page.click('#planOut .warn button');
  assert.equal(await page.evaluate(() => document.activeElement.matches('details.stock[open] > summary')), true, 'see the cut list doesn’t open the sizes to buy');
}

// A price is kept to the cent, so the shopping list's lines add up to its total: 3 × $4.285 and 3 × $5.485 used to
// show as $12.86 and $16.46 over a total of $29.31.
{
  await open(saved(project('Cents', [board('2×4', [{ len: 96, price: 4 }], [{ name: 'Leg', qty: 3, len: 90 }]), board('1×4 board', [{ len: 96, price: 5 }], [{ name: 'Slat', qty: 3, len: 90 }])])));
  assert.equal(await page.textContent('.proved'), 'Cheapest possible', 'two board materials, both proved');
  await view('list');
  for (const [i, typed] of [[0, '4.285'], [1, '5.485']]) {
    await page.click(`details.stock >> nth=${i}`);
    await page.fill(`details.stock >> nth=${i} >> input[data-f="price"]`, typed);
  }
  await view('plan');
  await page.waitForFunction(() => document.querySelector('.total').textContent !== '$27.00');
  const cents = t => Math.round(parseFloat(t.replace(/[^\d.]/g, '')) * 100);
  const lines = await page.$$eval('.shop tbody tr:not(.grp) td:last-child', tds => tds.map(td => td.textContent));
  const total = await page.textContent('.shop tfoot td:last-child');
  assert.equal(lines.length, 2);
  assert.equal(lines.reduce((a, t) => a + cents(t), 0), cents(total), `the shopping list ${lines.join(' + ')} doesn’t add up to ${total}`);
  assert.equal(await page.textContent('.total'), total);
}

// Secondary buttons line up with their headings and neighbours; only the plan's sections are spaced apart.
await page.click('#projBtn');
assert.deepEqual(await page.$$eval('#sheet .btn', bs => [...new Set(bs.map(b => getComputedStyle(b).marginTop))]), ['0px'], 'buttons in Projects');
await page.click('#pjx');
assert.equal(await page.$eval('#planOut div.sec', d => getComputedStyle(d).marginTop), '22px');

// A sheet with many steps keeps its heading and the parts legend company. Thirty drawer parts on one sheet of ½ plywood
// take 36 steps; the heading used to sit alone at the foot of the first page and the legend alone on a third.
{
  await open(saved(project('Drawer boxes', [sheet('½ plywood', [{ len: 96, wid: 48, price: 44 }, { len: 48, wid: 48, price: 26 }],
    [{ name: 'Drawer side', qty: 12, len: 20, wid: 5 }, { name: 'Drawer front/back', qty: 12, len: 14, wid: 5 }, { name: 'Drawer bottom', qty: 6, len: 19.5, wid: 13.5, grain: false }])])));
  assert.match(await page.textContent('#planOut .mdiag'), /1 sheet/);
  const pages = pdfPages(await shopPdf());
  const heading = r => r.bold && r.size === 12, legend = r => r.size === 8 && /^[A-Z] Drawer/.test(r.text);
  assert.ok(pages.some(p => p.some(legend)), 'no legend in the PDF');
  for (const [i, runs] of pages.entries()) {
    assert.ok(!heading(runs[runs.length - 1]), `page ${i + 1} ends with the heading "${runs[runs.length - 1].text}"`);
    assert.ok(!runs.every(legend), `page ${i + 1} holds only the legend`);
  }
  assert.match(pages[0].find(r => r.size === 9).text, /^Saw kerf 1\/8" · /, 'the header names the saw kerf');
}

// A thin kerf reads back as typed, in Settings and on the shop PDF: 3/32 used to show as 1/8", and 2.2 mm as 2 mm.
// So does a length typed to the 32nd or the tenth of a millimetre, in its own field, and an edit next to it doesn't
// save it back rounded: 23 3/32 used to become 23 1/8 when the cut list drew again.
{
  await open(saved(project('Thin kerf', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Rail', qty: 2, len: 30 }])])));
  await page.click('#setBtn');
  await page.fill('#sKerf', '3/32');
  await page.click('#sTrim');
  assert.equal(await page.inputValue('#sKerf'), '3/32"', 'a 3/32 kerf in Settings');
  await page.click('#stx');
  assert.match(pdfPages(await shopPdf())[0].find(r => r.size === 9).text, /^Saw kerf 3\/32" · /, 'the PDF header’s saw kerf');
  await view('list');
  const len = page.locator('#mats .prow[data-pid] input[data-f="len"]').first(), qty = page.locator('#mats .prow[data-pid] input[data-f="qty"]').first();
  await len.fill('23 3/32');
  await qty.click();
  await qty.fill('3');
  await page.waitForTimeout(600);
  assert.equal(await len.inputValue(), '23 3/32"', 'a length typed to the 32nd');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kerf.v1')).projects[JSON.parse(localStorage.getItem('kerf.v1')).current].materials[0].parts[0].len), 23 + 3 / 32, 'the length saved');
  await page.click('#setBtn');
  await page.click('#uSeg button[data-v="mm"]');
  await page.fill('#sKerf', '2.2');
  await page.click('#sTrim');
  assert.equal(await page.inputValue('#sKerf'), '2.2 mm', 'a 2.2 mm kerf in Settings');
  await page.click('#stx');
  await len.fill('603.3');
  await qty.click();
  await page.waitForTimeout(600);
  assert.equal(await len.inputValue(), '603.3', 'a length typed to the tenth of a millimetre');
}

// A sheet whose steps fit on a page keeps them with its drawing: in a big project, the ½ plywood's eight steps used to
// start under its drawing at the foot of one page and go on at the top of the next.
{
  const p = (name, qty, len, wid, grain = true) => wid == null ? { name, qty, len } : { name, qty, len, wid, grain };
  const ply = [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }];
  await open(saved(project('Mudroom', [
    board('2×4', [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }, { len: 144, price: 7.68 }, { len: 192, price: 10.98 }], [p('Bench front leg', 2, 17.25), p('Bench back leg', 2, 17.25), p('Coat wall cleat', 3, 70.5), p('Stretcher', 4, 44.75)]),
    board('1×6 board', [{ len: 72, price: 6.28 }, { len: 96, price: 8.28 }, { len: 30, have: 2 }], [p('Seat slat', 5, 46), p('Shiplap backer', 9, 47.5), p('Cubby divider', 4, 14.25)]),
    sheet('¾ plywood', ply, [p('Cubby side', 2, 34.5, 15.25), p('Cubby bottom', 1, 46.5, 15.25), p('Cubby top', 1, 46.5, 15.25), p('Back', 1, 46.5, 34.5, false), p('Shelf', 3, 45.75, 14)]),
    sheet('½ plywood', [{ len: 96, wid: 48, price: 44 }, { len: 48, wid: 48, price: 26 }], [p('Drawer side', 4, 14, 5.5), p('Drawer bottom', 2, 21.5, 13.5)]),
    board('1×4 board', [{ len: 72, price: 4.18 }, { len: 96, price: 5.48 }], [p('Face frame stile', 4, 34.5), p('Face frame rail', 3, 41)])])));
  const pages = pdfPages(await shopPdf());
  assert.ok(pages.length > 2, 'the project fits on too few pages to test');
  for (const [i, runs] of pages.entries()) {
    const first = runs.find(r => (r.bold && r.size === 10 && /^Sheet /.test(r.text)) || (!r.bold && r.size === 9 && /^\d+\. /.test(r.text)));
    assert.ok(!first || !/^([2-9]|\d\d+)\. /.test(first.text), `page ${i + 1} goes on with a sheet's steps: "${first && first.text}"`);
  }
}

// Labels fit their parts, and cut numbers stay on the sheet, clear of each other and of the part letters. On a phone the
// drawer parts are small: their numbers used to stack on each other and on the letters, and hang off the sheet; the
// bookcase's shelves read "34 1/2" × 11 1/434 1/2" × 11 1/4", run together; and a workbench's 2×4s "24 1/4"24 1/4"".
{
  const studs = [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }, { len: 144, price: 7.68 }, { len: 192, price: 10.98 }];
  const jobs = [
    project('Drawer boxes', [sheet('½ plywood', [{ len: 96, wid: 48, price: 44 }, { len: 48, wid: 48, price: 26 }],
      [{ name: 'Drawer side', qty: 12, len: 20, wid: 5 }, { name: 'Drawer front/back', qty: 12, len: 14, wid: 5 }, { name: 'Drawer bottom', qty: 6, len: 19.5, wid: 13.5, grain: false }])]),
    project('Bookcase', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }],
      [{ name: 'Side', qty: 2, len: 72, wid: 11.25 }, { name: 'Shelf', qty: 5, len: 34.5, wid: 11.25 }, { name: 'Top', qty: 1, len: 36, wid: 12 }])]),
    project('Workbench', [board('2×4', studs, [['Leg', 4, 33.25], ['Long apron', 2, 72], ['Short apron', 2, 24.25], ['Top frame long', 2, 72], ['Top frame short', 2, 27.25], ['Top joist', 8, 24.25],
      ['Shelf long', 2, 65], ['Shelf short', 4, 24.25], ['Shelf joist', 6, 24.25], ['Leg doubler', 4, 30.75], ['Brace', 4, 15.5]].map(([name, qty, len]) => ({ name, qty, len })))]),
  ];
  for (const job of jobs) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await open(saved(job));
    const bad = await page.evaluate(() => {
      const out = [], box = e => e.getBBox(), inside = (a, b, slack = 0.5) => a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.width <= b.x + b.width + slack && a.y + a.height <= b.y + b.height + slack;
      const meet = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      for (const svg of document.querySelectorAll('#planOut svg.diag')) {
        const parts = [...svg.querySelectorAll('rect.dg-part')].map(box), sheet = svg.querySelector('rect.dg-pedge');
        for (const t of svg.querySelectorAll('.dg-lbl, .dg-lblb')) if (!parts.some(p => inside(box(t), p))) out.push(`"${t.textContent}" runs out of its part`);
        if (!sheet) continue;
        const nums = [...svg.querySelectorAll('circle.dg-num')].map(c => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r'), n: c.nextElementSibling.textContent }));
        const letters = [...svg.querySelectorAll('.dg-lblb')].map(t => ({ b: box(t), t: t.textContent }));
        const s = box(sheet);
        nums.forEach((a, i) => {
          if (!inside({ x: a.x - a.r, y: a.y - a.r, width: 2 * a.r, height: 2 * a.r }, s)) out.push(`number ${a.n} hangs off the sheet`);
          nums.slice(i + 1).forEach(b => { if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) out.push(`numbers ${a.n} and ${b.n} overlap`); });
          const covers = letters.filter(l => meet({ x: a.x - a.r, y: a.y - a.r, width: 2 * a.r, height: 2 * a.r }, l.b));
          if (covers.length) out.push(`number ${a.n} covers ${covers.map(l => l.t).join(', ')}`);
        });
      }
      return out;
    });
    // On a phone, the drawers' right-hand column holds three small parts and five cuts in two fingers' width: one
    // number there can't help touching a letter.
    const allowed = job.name === 'Drawer boxes' && width === 390 ? 1 : 0;
    assert.ok(bad.filter(b => / covers /.test(b)).length <= allowed && !bad.some(b => !/ covers /.test(b)), `${job.name} at ${width} wide: ${bad.join('; ')}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// On a small phone a cabinet's and a 50-piece job's sheets are crowded with short cuts: number 15 sat right under 16, and
// numbers covered sizes such as 14" × 5 1/2". Every number shows whole, clear of the others and of every letter and size.
{
  const ply = [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }];
  const parts = list => list.map(([name, qty, len, wid, grain]) => ({ name, qty, len, wid, grain: grain !== false }));
  const jobs = [
    project('Base cabinet', [sheet('¾ plywood', ply, parts([['Side', 2, 34.5, 23.25], ['Bottom', 1, 34.5, 23.25], ['Top stretcher front', 1, 34.5, 4, false], ['Top stretcher back', 1, 34.5, 4, false],
      ['Back', 1, 34.5, 30.5], ['Shelf', 2, 33.75, 22], ['Toe kick', 1, 34.5, 4, false], ['Door', 2, 17.875, 30.25], ['Drawer front', 1, 35.75, 6],
      ['Drawer side', 2, 21, 5], ['Drawer front/back', 2, 31.5, 5, false], ['Nailer', 2, 34.5, 3, false]]))]),
    project('50 piece sheet job', [sheet('¾ plywood', ply, parts([['Tall side', 6, 72, 15.75], ['Shelf', 14, 30.25, 15], ['Top', 3, 31.75, 16], ['Back strip', 9, 30.25, 4, false],
      ['Door', 6, 15.5, 36], ['Kick', 3, 30.25, 3.5, false], ['Divider', 9, 15, 11.5]]))]),
    project('Mudroom cubbies', [sheet('¾ plywood', ply, parts([['Cubby side panel, left and right', 2, 34.5, 15.25], ['Cubby bottom', 1, 46.5, 15.25], ['Cubby top', 1, 46.5, 15.25],
      ['Back', 1, 46.5, 34.5, false], ['Shelf', 3, 45.75, 14]])), sheet('½ plywood', [{ len: 96, wid: 48, price: 44 }, { len: 48, wid: 48, price: 26 }], parts([['Drawer side', 4, 14, 5.5], ['Drawer bottom', 2, 21.5, 13.5]]))]),
  ];
  for (const job of jobs) for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await open(saved(job));
    const bad = await page.evaluate(() => {
      const out = [];
      for (const svg of document.querySelectorAll('#planOut svg.diag')) {
        const nums = [...svg.querySelectorAll('circle.dg-num')].map(c => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r'), n: c.nextElementSibling.textContent }));
        const labels = [...svg.querySelectorAll('.dg-lbl, .dg-lblb')].map(t => ({ b: t.getBBox(), t: t.textContent }));
        nums.forEach((a, i) => {
          nums.slice(i + 1).forEach(b => { if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) out.push(`numbers ${a.n} and ${b.n} overlap`); });
          // a number is a circle: it covers a label where the label's box comes nearer its centre than its radius
          const covers = labels.filter(({ b }) => Math.hypot(Math.max(b.x - a.x, 0, a.x - b.x - b.width), Math.max(b.y - a.y, 0, a.y - b.y - b.height)) < a.r);
          if (covers.length) out.push(`number ${a.n} covers ${covers.map(l => l.t).join(', ')}`);
        });
      }
      return out;
    });
    assert.deepEqual(bad, [], `${job.name} at ${width} wide`);
    // Lengths read as a tape does, ′ and ″, and one sheet's sizes all have their marks or all go without: the mudroom's
    // second sheet read 'A 34 1/2 × 15 1/4' beside 'E 45 3/4" × 14"'.
    const texts = await page.$$eval('#planOut svg.diag', svgs => svgs.map(svg => ({ all: [...svg.querySelectorAll('text')].map(t => t.textContent), sizes: [...svg.querySelectorAll('.dg-lbl')].map(t => t.textContent).filter(t => / × /.test(t)) })));
    const ascii = texts.flatMap(t => t.all).filter(t => /["']/.test(t));
    assert.deepEqual(ascii, [], `${job.name} at ${width} wide: a drawing uses " or '`);
    for (const { sizes } of texts) assert.ok(sizes.every(t => /″/.test(t)) || sizes.every(t => !/″/.test(t)), `${job.name} at ${width} wide: one sheet mixes sizes with and without marks: ${sizes.join(', ')}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// The grain stays on its board or part: its curves used to bulge past the end of a board by up to 2.6 px on a laptop,
// and showed as tan hooks past each 8′ board on a phone with one on hand.
{
  const studs = [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }, { len: 144, price: 7.68 }, { len: 192, price: 10.98 }];
  const example = (...more) => project('Shelves', [board('2×4', [...studs, ...more], [{ name: 'Leg', qty: 4, len: 72 }, { name: 'Front & back rail', qty: 8, len: 48 }, { name: 'Side rail', qty: 8, len: 21 }]),
    sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }], [{ name: 'Shelf', qty: 4, len: 47.75, wid: 23.75 }])]);
  for (const job of [example(), example({ len: 96, have: 1 })]) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await open(saved(job));
    const over = await page.$$eval('#planOut path.dg-grain', ps => ps.map(p => {
      const a = p.getBBox(), b = p.previousElementSibling.getBBox();
      return Math.max(b.x - a.x, a.x + a.width - b.x - b.width, b.y - a.y, a.y + a.height - b.y - b.height);
    }).filter(o => o > 0.5).map(o => o.toFixed(1)));
    assert.deepEqual(over, [], `the grain runs past its wood at ${width} wide`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// A board you already have says "yours" under its length, clear of the board, and its edge is dashed green like its
// size in the cut list. It used to say so after the board, taking room from every board, so on a phone the example with
// an 8′ 2×4 on hand lost the letters from its labels: "C 21"" read "21"".
await open(saved(project('Yours', [board('2×4', [{ len: 96, price: 4.28 }, { len: 96, have: 1 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
{
  const yours = await page.$eval('#planOut svg.diag', svg => {
    const t = [...svg.querySelectorAll('text')].filter(t => t.textContent === 'yours'), wood = svg.querySelector('rect.dg-wood').getBBox();
    return { n: t.length, cls: t[0].getAttribute('class'), clear: t[0].getBBox().x + t[0].getBBox().width <= wood.x - 2, dashed: svg.querySelectorAll('rect.dg-edge.have').length };
  });
  assert.deepEqual(yours, { n: 1, cls: 'dg-yours', clear: true, dashed: 1 }, 'a board you have isn’t marked as yours beside its length');
}
{
  const studs = [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }, { len: 144, price: 7.68 }, { len: 192, price: 10.98 }, { len: 96, have: 1 }];
  await open(saved(project('Shelves', [board('2×4', studs, [{ name: 'Leg', qty: 4, len: 72 }, { name: 'Front & back rail', qty: 8, len: 48 }, { name: 'Side rail', qty: 8, len: 21 }])])));
  const labels = await page.$$eval('#planOut svg.diag .dg-lbl', ts => ts.map(t => t.textContent));
  assert.ok(labels.length > 5 && labels.every(t => /^[A-C] /.test(t)), 'a board label lost its letter beside a board you have: ' + labels.join(', '));
}

// The shop PDF keeps everything on the page: a long project name stops short of the total, a board's parts and the
// legend wrap onto more lines instead of running off (and losing parts), and an emoji is left out, not printed as "??".
{
  const name = 'Workshop wall cabinet with sliding doors, French cleats and a tool shelf';
  const parts = [['Stile, left and right', 2, 30], ['Top rail with a groove', 1, 22.5], ['Bottom rail with a groove', 1, 22.5], ['Shelf cleat, short', 4, 9.75], ['Shelf cleat, long', 2, 21.25],
    ['French cleat for the wall', 1, 24], ['French cleat for the cabinet', 1, 24], ['Door stop block', 4, 3.5], ['Drawer runner 🪵', 2, 18], ['Back slat, tongue and groove', 3, 30]];
  await open(saved(project(name, [board('1×4 board', [{ len: 96, price: 5.48 }], parts.map(([name, qty, len]) => ({ name, qty, len })))], { cur: '€' })));
  const runs = pdfRuns(await shopPdf()), total = await page.textContent('.total');
  const title = runs.find(r => r.bold && r.size === 16), sum = runs.find(r => r.bold && r.size === 22);
  assert.equal(sum.text, total.replace('€', '\x80'), 'the total, with the euro sign in the PDF\'s own encoding');
  assert.ok(title.x + pdfWidth(title) < sum.x - 6, 'the project name runs under the total');
  for (const r of runs) assert.ok(r.x + pdfWidth(r) <= 612 - 40 + 0.5, `"${r.text}" runs past the right margin`);
  assert.ok(!runs.some(r => r.text.includes('?')), 'something printed as "?"');
  const all = runs.map(r => r.text).join(' ');
  for (const [i, [name, qty]] of parts.entries()) assert.ok(all.includes(`${'ABCDEFGHIJ'[i]} ${name.replace(' 🪵', '')} `) && all.includes(`×${qty}`), `part ${'ABCDEFGHIJ'[i]} is missing from the legend`);
}

// Dialogs take the keyboard: focus moves in, they're named by their heading, Tab goes on to their buttons and doesn't
// wander to the page behind, and closing one puts focus back on the button that opened it.
await page.focus('#setBtn');
await page.keyboard.press('Enter');
assert.ok(await page.evaluate(() => document.getElementById('sheet').contains(document.activeElement)), 'focus stays behind the Settings dialog');
assert.equal(await page.evaluate(() => { const d = document.querySelector('#sheet [role=dialog]'); return document.getElementById(d.getAttribute('aria-labelledby')).textContent; }), 'Settings for this project');
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'stx', 'Tab doesn’t go on to the dialog’s first button');
for (let i = 0; i < 9; i++) {
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => !document.getElementById('app').contains(document.activeElement) && !document.querySelector('.jd-foot').contains(document.activeElement)), 'Tab reached the page behind the dialog');
}
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => document.activeElement.id), 'setBtn', 'focus is lost when the dialog closes');
// In Projects, Tab reaches Open a project file, and Enter on it asks for the file (the file input's click opens the
// browser's file picker; here the click is noted and the picker left shut).
await page.focus('#projBtn');
await page.keyboard.press('Enter');
{
  const stops = [];
  for (let i = 0; i < 12 && stops[stops.length - 1] !== 'pjOpen'; i++) { await page.keyboard.press('Tab'); stops.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent)); }
  assert.equal(stops[stops.length - 1], 'pjOpen', 'Tab in Projects never reaches Open a project file: ' + stops.join(', '));
  await page.evaluate(() => document.getElementById('pjFile').addEventListener('click', e => { window.picked = true; e.preventDefault(); }));
  await page.keyboard.press('Enter');
  assert.ok(await page.evaluate(() => window.picked), 'Open a project file doesn’t ask for a file');
  await page.keyboard.press('Escape');
}

// On a phone the top bar's buttons show only their icons, but each still has a name.
for (const name of ['Projects', 'Shop PDF', 'Settings']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `no button named ${name} on a phone`);

// Fields, tips and cuts say what they belong to. A part's fields are named by its letter, its name as typed and the
// column ("B Front & back rail Length"), and follow a rename; a size's price, menu and ✕ name the size; a tip's button
// is described by the tip; at the saw each board is a group named by its heading, each cut says which of the board's
// it is, and a fraction reads 15/16, not "superscript 15 subscript 16".
{
  await open(null);
  await view('list');
  await page.evaluate(() => document.querySelectorAll('details.stock').forEach(d => { d.open = true; }));
  const named = (role, name) => page.getByRole(role, { name, exact: true }).count();
  assert.equal(await page.locator('.mat').first().getByRole('textbox', { name: 'Part A name', exact: true }).count(), 1, 'no textbox named “Part A name”');
  for (const [role, name] of [['textbox', 'A Leg Quantity'], ['textbox', 'B Front & back rail Length'], ['textbox', 'D Shelf Width'], ['button', 'D Shelf Keep grain along the length'],
    ['textbox', 'Price for the 8 ft size'], ['combobox', 'Where the 10 ft size comes from'], ['button', 'Remove the 16 ft size'], ['textbox', 'Price for the 4 ft × 8 ft size']])
    assert.equal(await named(role, name), 1, `no ${role} named “${name}”`);
  // Letters run through the project, material after material: the example's 2×4 parts are A to C, so its shelf is D.
  assert.deepEqual(await page.$$eval('#mats .plet', ls => ls.map(l => l.textContent)), ['A', 'B', 'C', 'D'], 'the cut list doesn’t letter the parts through the project');
  await page.fill('.prow[data-pid] >> nth=1 >> [data-f="pname"]', 'Rail');
  assert.equal(await named('textbox', 'B Rail Length'), 1, 'a part’s fields keep its old name');
  await page.fill('.srow[data-sid] >> nth=0 >> [data-f="slen"]', '7\'');
  await page.locator('.srow[data-sid] >> nth=0 >> [data-f="slen"]').blur();
  assert.equal(await named('textbox', 'Price for the 7 ft size'), 1, 'a price keeps its size’s old length');
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  assert.match(await page.locator('[data-tip]').evaluate(b => document.getElementById(b.getAttribute('aria-describedby')).textContent), /^Make Front & back rail 47 15\/16/, 'a tip’s button isn’t described by its tip');
  assert.match(await page.locator('#tips').ariaSnapshot(), /Make Front & back rail 47 15\/16 ?″ instead of 48″/);
  await view('saw');
  // Board 2 is cut like board 1, so it's folded: a button that says so and opens on a press.
  const board2 = page.getByRole('group', { name: 'Board 2, same as board 1, 2×4, 10 ft', exact: true });
  assert.equal(await board2.count(), 1, 'no group named for board 2');
  const fold2 = board2.getByRole('button', { name: /^Board 2 — same as board 1 0\/3/ });
  assert.equal(await fold2.getAttribute('aria-expanded'), 'false', 'board 2 isn’t folded');
  assert.equal(await board2.getByRole('checkbox').count(), 0, 'a folded board shows its cuts');
  await fold2.press('Enter');
  assert.equal(await board2.getByRole('button').getAttribute('aria-expanded'), 'true', 'board 2 doesn’t open');
  assert.ok(await board2.getByRole('button').evaluate(b => b === document.activeElement), 'focus doesn’t stay on board 2’s heading');
  assert.equal(await board2.getByRole('checkbox', { name: /^48″ B Front & back rail .*, cut 2 of 3$/ }).count(), 1, 'a cut doesn’t say which of its board’s it is');
  const saw = await page.locator('#sawOut').ariaSnapshot();
  assert.ok(/Leaves a 2 5\/8 ?″ offcut/.test(saw) && !/superscript|subscript|⁄/.test(saw), 'a fraction at the saw reads as its parts:\n' + saw.slice(0, 600));
}

// Which tab, view and units are on is said, not only shown: the tab you're on is the current page and the switches are
// pressed. A material's ✕ armed for a second press says so, and says ✕ again once it disarms. In Projects the open
// project is marked in words, and Delete asks for a press, not a tap.
{
  await open(null);
  const state = () => page.evaluate(() => ({
    tab: [...document.querySelectorAll('#tabs button[aria-current="page"]')].map(b => b.dataset.t),
    seg: [...document.querySelectorAll('#rseg button')].map(b => b.dataset.t + ' ' + b.getAttribute('aria-pressed')) }));
  assert.deepEqual(await state(), { tab: ['plan'], seg: ['plan true', 'saw false'] });
  await view('saw');
  assert.deepEqual(await state(), { tab: ['saw'], seg: ['plan false', 'saw true'] });
  await view('list');
  assert.deepEqual((await state()).tab, ['list']);
  await page.click('[data-a="delmat"]');
  assert.equal(await page.getAttribute('[data-a="delmat"]', 'aria-label'), 'Remove 2×4 and its parts? Press again to remove');
  await page.waitForFunction(() => document.querySelector('[data-a="delmat"]').textContent === '✕', null, { timeout: 5000 });
  assert.equal(await page.getAttribute('[data-a="delmat"]', 'aria-label'), 'Remove 2×4', 'a disarmed ✕ still asks');
  await page.click('#setBtn');
  const units = () => page.$$eval('#uSeg button', bs => bs.map(b => b.textContent + ' ' + b.getAttribute('aria-pressed')));
  assert.deepEqual(await units(), ['Inches true', 'Millimeters false']);
  await page.click('#uSeg button[data-v="mm"]');
  assert.deepEqual(await units(), ['Inches false', 'Millimeters true']);
  await page.click('#stx');
  await page.click('#projBtn');
  assert.deepEqual(await page.$$eval('#pjList .pitem[aria-current="true"]', bs => bs.map(b => / · open$/.test(b.querySelector('span').textContent))), [true], 'the open project isn’t marked in words');
  await page.click('#sheet .danger');
  assert.equal(await page.textContent('#sheet .danger'), 'Press again to delete “Garage shelves (example)”');
  await page.click('#pjx');
}

// The page has an outline a screen reader can move through on a phone too: the project's name as its first heading,
// then the cut list, the plan and the saw, and the plan's diagrams named by their material and count, apart.
{
  await open(null);
  const heads = () => page.$$eval('h1,h2,h3,h4', hs => hs.filter(h => !h.closest('[hidden]') && getComputedStyle(h).display !== 'none' && h.getClientRects().length).map(h => h.tagName[1] + ' ' + h.textContent));
  assert.deepEqual(await heads(), ['1 Garage shelves (example)', '2 Plan', '3 Shopping list', '4 2×4, 8 boards', '4 ¾ plywood, 1 sheet']);
  assert.equal(await page.getByRole('heading', { level: 4, name: /^2×4\s*,\s*8 boards$/ }).count(), 1, 'the diagram’s heading runs its words together');
  await page.fill('#pname', 'Shelves');
  assert.equal(await page.textContent('h1'), 'Shelves', 'the page’s heading keeps the old name');
  await view('list');
  assert.deepEqual(await heads(), ['1 Shelves', '2 What you need to cut']);
  await view('saw');
  assert.deepEqual(await heads(), ['1 Shelves', '2 At the saw']);
}

// A screen reader gets each drawing in words: which parts go on each board and what offcut it leaves, and what each
// sheet holds and what's left of it. The drawings themselves are left out for it.
{
  await open(null);
  const plan = await page.locator('#planOut').ariaSnapshot();
  assert.ok(plan.includes('listitem: "Boards 1 to 4, each 10 ft: B 48 in, B 48 in, C 21 in, leaves a 2 5/8 in offcut"') && plan.includes('listitem: "Boards 5 to 8, each 8 ft: A 72 in, C 21 in, leaves a 2 3/4 in offcut"'), 'the boards aren’t in words:\n' + plan);
  assert.ok(plan.includes('paragraph: "Sheet 1, 48 in × 96 in: 4 × D Shelf 47 3/4 in × 23 3/4 in"'), 'the sheet isn’t in words:\n' + plan);
  assert.ok(!/- img/.test(plan), 'a drawing is still read as a picture');
  await open(saved(project('Sides', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 30.25, wid: 23.75 }])])));
  assert.match(await page.locator('#planOut').ariaSnapshot(), /paragraph: "Sheet 1, 48 in × 96 in: 2 × A Side 30 1\/4 in × 23 3\/4 in; left over 96 in × 24 1\/8 in and 35 1\/4 in × 23 3\/4 in"/);
}

// Ticking a cut from the keyboard keeps focus on that cut, and Start over moves it to the first one.
await view('saw');
await page.locator('#sawOut .cut[data-k]').nth(1).focus();
await page.keyboard.press('Space');
assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.k.split('/')[1], document.activeElement.getAttribute('aria-checked')]), ['0.1', 'true'], 'focus left the cut just ticked');
await page.focus('#sawReset');
await page.keyboard.press('Enter');
assert.equal(await page.evaluate(() => document.activeElement.dataset.k.split('/')[1]), '0.0', 'focus after Start over');
assert.match(await page.textContent('.saw-bar b'), /^0 of /);

// Boards cut alike are drawn once: the example's eight 2×4s are two rows, "1–4" over "10′ ×4" and "5–8" over "8′ ×4",
// and so on the shop PDF. At the saw each board keeps its row and its own ticks: board 2, cut like board 1, is folded
// until board 1 is done, then opens with the next cut, while boards 3 and 4 stay folded (and board 1, done, folds).
{
  await open(null);
  const rows = await page.$$eval('#planOut .mdiag svg.diag', ([svg]) => [...svg.querySelectorAll('text.dg-metab')].map(t => t.textContent + ' ' + t.nextElementSibling.textContent));
  assert.deepEqual(rows, ['1–4 10′ ×4', '5–8 8′ ×4'], 'the 2×4s aren’t drawn a row to each run of boards cut alike');
  const pdf = pdfRuns(await shopPdf()).map(r => r.text);
  assert.ok(['1\x964', "10' ×4", '5\x968', "8' ×4"].every(t => pdf.includes(t)), 'the shop PDF doesn’t draw boards cut alike once: ' + pdf.slice(0, 40).join(' / '));
  await view('saw');
  const heads = () => page.$$eval('#sawOut .stk-hd', hs => hs.map(h => h.textContent));
  assert.deepEqual((await heads()).slice(0, 4), ['Board 12×4 · 10′0/3', 'Board 2— same as board 10/3›', 'Board 3— same as board 10/3›', 'Board 4— same as board 10/3›']);
  for (let i = 0; i < 3; i++) await page.locator('#sawOut .cut[data-k]').nth(i).click();
  assert.deepEqual((await heads()).slice(0, 3), ['Board 12×4 · 10′3/3 ✓›', 'Board 2— same as board 10/3', 'Board 3— same as board 10/3›'], 'board 2 didn’t open once board 1 was done');
  assert.match(await page.textContent('#sawOut .cut.next'), /Next B Front & back rail/);
  assert.match(await page.getAttribute('#sawOut .cut.next', 'data-k'), /\/1\.0$/, 'the next cut isn’t board 2’s first');
  await page.locator('#sawOut .cut.next').click();
  await page.waitForTimeout(600);
  const ticks = await page.evaluate(() => { const db = JSON.parse(localStorage.getItem('kerf.v1')); const d = db.projects[db.current].done; return Object.values(d).map(x => Object.keys(x.ticks).sort().join(' ')).join(' | '); });
  assert.equal(ticks, '0.0 0.1 0.2 1.0', 'the ticks aren’t kept board by board');
  await page.reload(); await page.waitForSelector('#sawOut .cut[data-k]');
  assert.deepEqual((await heads()).slice(0, 3), ['Board 12×4 · 10′3/3 ✓›', 'Board 2— same as board 11/3', 'Board 3— same as board 10/3›'], 'a reload folds a board with ticks');
}

// At tablet and laptop widths a drawing names each part where there's room: "B Front & back rail 48″" on a board, and on
// a sheet part with room for three lines, its name between its letter and its size. A long name is cut short with …
// to fit. The shop PDF does the same. On a phone the drawings keep to letters, which the legend names.
{
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(null);
  const labels = () => page.$$eval('#planOut svg.diag .dg-lbl:not(.dg-nm)', ts => ts.map(t => {
    const r = t.previousElementSibling, a = t.getBBox(), b = r && r.matches('rect.dg-part') ? r.getBBox() : null;
    return { t: t.textContent, inside: !b || (a.x >= b.x && a.x + a.width <= b.x + b.width) };
  }));
  let got = await labels();
  assert.ok(['B Front & back rail 48″', 'C Side ra… 21″', 'A Leg 72″'].every(t => got.some(l => l.t === t)), 'the boards don’t name their parts: ' + got.map(l => l.t).join(', '));
  assert.deepEqual(await page.$$eval('#planOut svg.diag .dg-nm', ts => ts.map(t => t.textContent)), ['Shelf', 'Shelf', 'Shelf', 'Shelf'], 'the sheet doesn’t name its parts');
  assert.ok(got.every(l => l.inside), 'a label runs past its part: ' + JSON.stringify(got.filter(l => !l.inside)));
  const pdf = pdfRuns(await shopPdf()).map(r => r.text);
  assert.ok(['B Front & back rail 48"', 'A Leg 72"', 'Shelf'].every(t => pdf.includes(t)), 'the shop PDF’s drawings don’t name their parts');
  await open(saved(project('Face frame', [board('1×2 board', [{ len: 96, price: 3.5 }], [{ name: 'Face frame stile, left and right', qty: 2, len: 34.5 }])])));
  got = await labels();
  assert.ok(got.length === 2 && got.every(l => /^A Face frame.*… 34 1\/2″$/.test(l.t) && l.inside), 'a long name isn’t cut short to fit: ' + JSON.stringify(got));
  await page.setViewportSize({ width: 390, height: 844 });
  await open(null);
  assert.ok((await page.$$eval('#planOut svg.diag .dg-lbl', ts => ts.map(t => t.textContent))).every(t => !/[a-z]{2}/.test(t)), 'a phone’s drawing names its parts');
}

// On a 320 px phone the project's name had room for "Gara", cut off with no sign of more: under 360 px it gets a line of
// its own, ending in … if it's still too long. The tip's button goes under its words, and a size in the shopping list
// stays on one line. At 390 the name stays beside the brand.
{
  await page.setViewportSize({ width: 320, height: 640 });
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  const top = await page.evaluate(() => {
    const n = document.getElementById('pname'), b = document.querySelector('.brand').getBoundingClientRect(), r = n.getBoundingClientRect();
    const tip = document.querySelector('.tip'), words = tip.querySelector('span:not(.tag)').getBoundingClientRect(), btn = tip.querySelector('button').getBoundingClientRect();
    return { width: r.width, below: r.top >= b.bottom, ellipsis: getComputedStyle(n).textOverflow, button: btn.top >= words.bottom - 1 && btn.right > words.right - 2,
      sizes: [...document.querySelectorAll('.shop .dims')].every(d => d.getClientRects().length === 1 && d.getBoundingClientRect().height < 26) };
  });
  assert.ok(top.width > 250 && top.below, 'the project name has no line of its own at 320: ' + JSON.stringify(top));
  assert.deepEqual([top.ellipsis, top.button, top.sizes], ['ellipsis', true, true], 'at 320: ' + JSON.stringify(top));
  await fitsPhone('plan at 320');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => { const n = document.getElementById('pname').getBoundingClientRect(), b = document.querySelector('.brand').getBoundingClientRect(); return n.top < b.bottom && n.left > b.right; }), 'at 390 the project name left the brand’s line');
}

// The last tick of the job says so: the bar reads "All 2 cuts done" in green, with Start over after it, and a toast
// says the project is ready to put together. That toast comes from the tick, so a reload of a finished job doesn't
// show it again, and unticking and ticking the last cut does.
{
  await open(saved(project('Bench', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 3, len: 30 }])])));
  await view('saw');
  const toastSays = () => page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : ''; });
  const hush = () => page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  const done = page.locator('#sawOut .cut[data-k]');
  assert.equal(await done.count(), 3);
  await done.nth(0).click();
  await done.nth(1).click();
  assert.equal(await toastSays(), '', 'a toast before the job is done');
  await done.nth(2).click();
  assert.equal(await toastSays(), 'That’s every cut. Bench is ready to put together.');
  assert.deepEqual(await page.$eval('.saw-bar b', b => [b.textContent, getComputedStyle(b).color === getComputedStyle(document.querySelector('.stk.done .stk-hd .n')).color, b.nextElementSibling.id]),
    ['All 3 cuts done', true, 'sawReset'], 'the bar doesn’t say the job is done');
  // The finished board folds to its heading, which keeps the focus, and a tap opens it with its ticks.
  assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('#sawOut .cut[data-k]').length, document.activeElement.matches('.stk.fold.done [data-fold][aria-expanded="false"]')]), [0, true], 'the finished board didn’t fold, with the focus on its heading');
  assert.equal(shown(await page.textContent('#sawOut .stk-hd')), 'Board 12×4 · 8′3/3 ✓›');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#sawOut .stk');
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('.saw-bar b'), 'All 3 cuts done');
  assert.equal(await toastSays(), '', 'a reload of a finished job toasts');
  await page.click('#sawOut [data-fold]');
  assert.equal(await done.count(), 3, 'a tap doesn’t open a finished board');
  await done.nth(2).click();
  assert.equal(await page.textContent('.saw-bar b'), '2 of 3 cuts');
  await hush();
  await done.nth(2).click();
  assert.equal(await toastSays(), 'That’s every cut. Bench is ready to put together.', 'ticking the last cut again doesn’t say so');
  assert.equal(await done.count(), 0, 'a board opened by a tap stays open once its last cut is ticked again');
  // A long material name wraps beside "Board 1"; it used to split it into "Board" over "1".
  await open(saved(project('Bench', [board('1×6 board — select pine, kiln dried, from the big orange store', [{ len: 96, price: 8.28 }], [{ name: 'Slat', qty: 2, len: 46 }])])));
  await view('saw');
  assert.ok(await page.$$eval('#sawOut .stk-hd b', bs => bs.every(b => b.getClientRects().length === 1 && b.getBoundingClientRect().height < 26)), 'a board’s name splits over two lines');
}

// At the saw on a short screen (a phone on its side, or 200% zoom), each board's heading stays in sight under the top
// bar and the saw's own bar while its cuts scroll by, and Shift+Tab up the list never leaves the focused cut under
// either. Their cards don't clip, so a focus ring shows whole.
{
  await page.setViewportSize({ width: 640, height: 400 });
  await open(null);
  await view('saw');
  const cover = () => page.evaluate(() => {
    // a folded board's heading is a button of its own, kept clear of the top bar
    const a = document.activeElement, r = a.getBoundingClientRect(), hd = a.matches('.stk-hd') ? { bottom: 0 } : a.closest('.stk').querySelector('.stk-hd').getBoundingClientRect();
    return { top: Math.round(r.top), under: Math.round(Math.max(document.querySelector('.top').getBoundingClientRect().bottom, document.querySelector('.saw-bar').getBoundingClientRect().bottom, hd.bottom)) };
  });
  await page.locator('#sawOut .cut[data-k]').last().focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+Tab');
    const c = await cover();
    assert.ok(c.top >= c.under - 1, `Shift+Tab ${i + 1} left the focused cut under the top bar or its board's heading: ${JSON.stringify(c)}`);
  }
  const stuck = await page.evaluate(() => {
    const bar = document.querySelector('.saw-bar').getBoundingClientRect().bottom, card = [...document.querySelectorAll('#sawOut .stk')].pop();
    scrollBy(0, card.getBoundingClientRect().top - bar + 90);
    return [Math.round(card.querySelector('.stk-hd').getBoundingClientRect().top), Math.round(bar), card.querySelector('.stk-hd b').textContent.replace(/\u00a0/g, ' ')];
  });
  assert.deepEqual(stuck, [stuck[1], stuck[1], '¾ plywood · Sheet 1'], 'a board\'s heading scrolls away with its cuts');
  assert.deepEqual(await page.evaluate(() => ['.stk', '.seg', '.cut'].map(s => getComputedStyle(document.querySelector(s)).overflow)), ['visible', 'visible', 'visible'], 'a card clips its focus rings');
  await page.setViewportSize({ width: 390, height: 844 });
}

// An action that draws the cut list again leaves keyboard focus where the work is, not on the page itself with the
// next Tab at the top: a part's ✕ moves it to the next part's ✕ (or the one before, or + Add a part), a size's ✕ to
// the next size's, a material's ✕ to the next material's name (or the buttons that add one), a tip's Use to the field
// it changed, and the arrow keys step a size's Source menu through Buy, Have 1, Have 2 without losing it. Undo waits
// while focus is on it, and from the keyboard puts focus back on the part.
{
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(null);
  const focused = () => page.evaluate(() => { const a = document.activeElement; return [a.dataset.a || a.dataset.f || a.tagName, a.tagName === 'INPUT' ? a.value : a.getAttribute('aria-label') || a.textContent]; });
  const press = async (sel, key = 'Enter') => { await page.locator(sel).focus(); await page.keyboard.press(key); };
  const delPart = n => `.mat >> nth=0 >> .prow[data-pid] >> nth=${n} >> [data-a="delpart"]`;
  await press(delPart(0));
  assert.deepEqual(await focused(), ['delpart', 'Remove Front & back rail'], 'focus after removing a part');
  await page.locator('#toast button').waitFor({ state: 'visible' });
  await page.locator('#toast button').focus();
  await page.waitForTimeout(6500);
  assert.ok(await page.evaluate(() => document.getElementById('toast').classList.contains('show')), 'the toast went while its Undo had focus');
  await page.keyboard.press('Enter');
  assert.deepEqual(await focused(), ['delpart', 'Remove Leg'], 'focus after Undo from the keyboard');
  await press(delPart(2));
  assert.deepEqual(await focused(), ['delpart', 'Remove Front & back rail'], 'focus after removing the last part');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.deepEqual(await focused(), ['addpart', '+ Add a part'], 'focus after removing every part');
  await open(null);
  await page.evaluate(() => document.querySelectorAll('details.stock').forEach(d => { d.open = true; }));
  const sizeIds = () => page.evaluate(() => [...document.querySelector('.mat').querySelectorAll('.srow[data-sid]')].map(r => r.dataset.sid));
  const before = await sizeIds();
  await press('.mat >> nth=0 >> .srow[data-sid] >> nth=0 >> [data-a="delstock"]');
  assert.deepEqual([await focused(), await page.evaluate(() => document.activeElement.closest('.srow').dataset.sid)], [['delstock', 'Remove the 10 ft size'], before[1]], 'focus after removing a size');
  await press('.mat >> nth=0 >> .srow[data-sid] >> nth=2 >> [data-a="delstock"]');
  assert.deepEqual(await focused(), ['addstock', '+ Size to buy'], 'focus after removing the last size');
  const menu = '.mat >> nth=0 >> .srow[data-sid] >> nth=0 >> select';
  const sid = await page.locator(menu).evaluate(s => s.closest('.srow').dataset.sid);
  await page.locator(menu).focus();
  for (const want of ['1', '2', '3']) {
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.f, document.activeElement.value, document.activeElement.closest('.srow').dataset.sid]), ['have', want, sid], 'the Source menu lost focus at Have ' + want);
  }
  assert.ok(await page.locator('.mat >> nth=0 >> .srow[data-sid] >> nth=0 >> [data-f="price"]').isDisabled(), 'a size you have still has a price');
  await press('.mat >> nth=0 >> [data-a="delmat"]');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  assert.deepEqual(await focused(), ['mname', '¾ plywood'], 'focus after removing a material');
  await press('[data-a="delmat"]');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  assert.deepEqual(await focused(), ['BUTTON', '2×4'], 'focus after removing the last material');
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  await press('[data-tip]');
  assert.deepEqual(await focused(), ['len', '47 15/16"'], 'focus after using a tip');
  await page.setViewportSize({ width: 390, height: 844 });
}

// A tip goes as soon as it's out of date: the frame after it's applied, or after its part is removed, the tips box
// no longer offers it, though Kerf is still looking for new tips. Side by side on a wide screen, so the plan shows.
{
  await page.setViewportSize({ width: 1280, height: 800 });
  const RAIL_TIP = 'Make Front & back rail 47 15⁄16″ instead of 48″';
  // The tips on screen in the frame after the next tap, once its handler has run.
  const tipsAfterTap = async tap => {
    await page.evaluate(() => { window.tipsAfter = null; document.addEventListener('click', () => requestAnimationFrame(() => { window.tipsAfter = [...document.querySelectorAll('#tips .tip')].map(t => t.textContent); }), { once: true, capture: true }); });
    await tap();
    await page.waitForFunction(() => window.tipsAfter);
    return (await page.evaluate(() => window.tipsAfter)).map(shown);
  };
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  assert.ok(shown(await page.textContent('#tips')).includes(RAIL_TIP + ' and you spend $4.12 less on 2×4, and it leaves no spare length on the 8′ boards.'), 'the tip’s words: ' + shown(await page.textContent('#tips')));
  const applied = await tipsAfterTap(() => page.click('[data-tip]'));
  assert.equal(await page.inputValue('.prow[data-pid] >> nth=1 >> [data-f="len"]'), '47 15/16"');
  // The toast says what the tip saved, as the tip did, with the length kept on one line.
  assert.equal(await page.textContent('#toast'), 'Front & back rail is now 47\u00a015/16″ — $4.12 less to buy');
  assert.ok(!applied.some(t => t.includes(RAIL_TIP)), 'the tip just applied is still offered: ' + applied.join(' / '));
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  const removed = await tipsAfterTap(() => page.click('.prow[data-pid] >> nth=1 >> [data-a="delpart"]'));
  assert.ok(!removed.some(t => t.includes('Front & back rail')), 'a removed part’s tip is still offered: ' + removed.join(' / '));
  await page.setViewportSize({ width: 390, height: 844 });
}

// A tip does what it says even when it's tapped while Kerf is still looking for new tips after an edit (a slow
// sheet job keeps it looking for a while). Side by side on a wide screen, so the edit and the tap are quick.
{
  await page.setViewportSize({ width: 1280, height: 800 });
  const cabinet = sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }], [
    { name: 'Side', qty: 4, len: 34.5, wid: 23.25 }, { name: 'Top & bottom', qty: 2, len: 30, wid: 23.25 }, { name: 'Stretcher', qty: 4, len: 30, wid: 4, grain: false },
    { name: 'Shelf', qty: 6, len: 28.5, wid: 11.25 }, { name: 'Door', qty: 2, len: 33, wid: 15.75 }, { name: 'Drawer side', qty: 8, len: 15, wid: 6, grain: false }]);
  const studs = board('2×4', [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }, { len: 144, price: 7.68 }, { len: 192, price: 10.98 }],
    [{ name: 'Leg', qty: 4, len: 72 }, { name: 'Front & back rail', qty: 8, len: 48 }, { name: 'Side rail', qty: 8, len: 21 }]);
  await open(saved(project('Tips', [cabinet, studs])));
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  assert.equal(await page.textContent('[data-tip]'), 'Use 47\u00a015/16″', 'the tip’s button doesn’t read as a tape does, on one line');
  await page.evaluate(() => { window.redrawn = new Promise(done => new MutationObserver((m, o) => { o.disconnect(); done(); }).observe(document.getElementById('planOut'), { childList: true })); });
  await page.fill('.prow[data-pid] input[data-f="pname"] >> nth=0', 'Side panel');
  await page.evaluate(() => window.redrawn);
  await page.waitForTimeout(150);
  await page.click('[data-tip]');
  await page.waitForFunction(() => [...document.querySelectorAll('.prow[data-pid]')].some(r => r.querySelector('[data-f="pname"]').value === 'Front & back rail' && r.querySelector('[data-f="len"]').value === '47 15/16"'), null, { timeout: 3000 })
    .catch(() => assert.fail('a tip tapped while tips were being checked did nothing'));
  await page.setViewportSize({ width: 390, height: 844 });
}

// Looking for tips doesn't hold the page up. A material of more than 60 sheet pieces gets none (a quick solve of it
// takes a phone too long); smaller ones are checked one quick solve at a time, while the page is idle.
{
  const parts = Array.from({ length: 8 }, (_, i) => ({ name: 'Drawer part ' + (i + 1), qty: 35, len: 10 + i * 3.5, wid: 6 + i * 1.25, grain: i % 2 === 0 }));
  await open(saved(project('Shop drawers', [sheet('½ plywood', [{ len: 96, wid: 48, price: 44 }, { len: 48, wid: 48, price: 26 }], parts)])));
  const longest = await page.evaluate(() => new Promise(done => {
    let max = 0;
    const o = new PerformanceObserver(list => list.getEntries().forEach(e => { max = Math.max(max, e.duration); }));
    o.observe({ type: 'longtask' });
    setTimeout(() => { o.disconnect(); done(max); }, 3000);
  }));
  assert.ok(longest < 200, `looking for tips held the page up for ${Math.round(longest)} ms`);
}

// An edit plans again only the materials it changes. In a copy of the page that notes each material it plans (a full
// solve of the material itself; the tips search's solves of shaved copies aren't plans), a part's count or length plans only its own material, and
// renaming a part plans nothing, yet the plan, the steps at the saw and the cut list's notes all use the new name.
// A reload plans everything afresh and finds the same plan, to the last cut.
{
  const counted = kerfSource.replace(/function solve(Boards|Sheets)\(mat, cfg, quick\) \{/g, '$& if (!quick && !cfg.replay && P.materials.indexOf(mat) >= 0) planned.push(mat.name);')
    .replace('<script>(function () {', '<script>var planned = [], solves = 0;</script>$&').replace('var go = function () { GEN++;', '$& solves++;');
  assert.equal(counted.split('planned.push(').length, 3, 'the solvers aren’t where this test looks for them');
  assert.ok(counted.includes('GEN++; solves++;'), 'the project solve isn’t where this test looks for it');
  const counting = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const cp = await counting.newPage();
    cp.on('pageerror', e => problems.push('counting: ' + e.message));
    await cp.route(base, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: counted }));
    const shelves = project('Shelves', [
      board('2×4', [{ len: 96, price: 4.28 }, { len: 120, price: 6.38 }], [{ name: 'Leg', qty: 4, len: 72 }, { name: 'Rail', qty: 8, len: 48 }]),
      sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 24, price: 21 }], [{ name: 'Shelf', qty: 4, len: 47.75, wid: 23.75 }, { name: 'Top', qty: 1, len: 100, wid: 30 }])]);
    await cp.goto(base + 'blank');
    await cp.evaluate(d => localStorage.setItem('kerf.v1', JSON.stringify(d)), { ...saved(shelves), tab: 'list' });
    await cp.goto(base);
    await cp.waitForSelector('#planOut > *', { state: 'attached' });
    const newlyPlanned = () => cp.evaluate(() => planned.splice(0));
    assert.deepEqual(await newlyPlanned(), ['2×4', '¾ plywood'], 'opening the project doesn’t plan each material once');
    // Each edit waits for the project to be solved again (on the cut list tab the plan isn't drawn until it shows).
    const edit = async (f, i, value) => {
      const before = await cp.evaluate(() => solves);
      await cp.fill(`.prow[data-pid] input[data-f="${f}"] >> nth=${i}`, value);
      await cp.waitForFunction(n => solves > n, before, { timeout: 10000 }).catch(() => assert.fail('the project wasn’t solved again'));
      return newlyPlanned();
    };
    assert.deepEqual(await edit('qty', 2, '5'), ['¾ plywood'], 'a shelf’s count planned more than the plywood');
    assert.deepEqual(await edit('len', 0, '70 1/2'), ['2×4'], 'a leg’s length planned more than the 2×4s');
    assert.deepEqual(await edit('pname', 0, 'Long leg'), [], 'renaming a part planned again');
    assert.deepEqual(await edit('pname', 3, 'Bench top'), [], 'renaming a part too big for any sheet planned again');
    assert.match(await cp.textContent('.sheetmat .perr'), /^Bench top \(100″ × 30″\) won’t fit/, 'the cut list has the old name');
    // The project's notes aren't anything a plan is worked out from: typing them saves, and solves nothing.
    const solved = await cp.evaluate(() => solves);
    await cp.fill('#pnotes', 'Glue the top');
    await cp.waitForFunction(() => (localStorage.getItem('kerf.v1') || '').includes('Glue the top'), null, { timeout: 5000 });
    assert.equal(await cp.evaluate(() => solves), solved, 'typing the notes solved the project again');
    assert.deepEqual(await newlyPlanned(), [], 'typing the notes planned again');
    // Both seen on the Plan tab, where the plan is drawn once it shows.
    const plan = () => cp.evaluate(() => [...document.getElementById('planOut').children].filter(c => c.id !== 'tips').map(c => c.outerHTML).join('') + document.getElementById('sawOut').innerHTML);
    await cp.click('#tabs button[data-t="plan"]');
    assert.match(await cp.textContent('#planOut .mdiag'), /Long leg · 4 × 70/, 'the plan has the old name');
    assert.match(await cp.textContent('#sawOut'), /A Long leg/, 'the steps at the saw have the old name');
    const kept = await plan();
    await cp.waitForFunction(() => { const s = localStorage.getItem('kerf.v1') || ''; return s.includes('Bench top') && s.includes('"tab":"plan"'); }, null, { timeout: 5000 });
    await cp.reload();
    await cp.waitForSelector('#planOut > *', { state: 'attached' });
    assert.deepEqual(await newlyPlanned(), ['2×4', '¾ plywood'], 'a reload didn’t plan afresh');
    const anew = await plan();
    if (anew !== kept) {
      let i = 0; while (anew[i] === kept[i]) i++;
      const near = s => '…' + s.slice(Math.max(0, i - 100), i + 100) + '…';
      assert.fail(`the plan kept between edits isn’t the one a fresh start finds:\n  kept  ${near(kept)}\n  fresh ${near(anew)}`);
    }
  } finally { await counting.close(); }
}

// Typing a length waits for a pause before planning: a fifth of a second, or about two thirds for a material whose
// last plan took over 80 ms. On a slow phone a ¾ plywood cabinet held each key for about a third of a second
// planning '3', '30' and '30 1' on the way to '30 1/4'. Here every plywood plan takes 120 ms: '30 1/4' typed a key
// every 300 ms plans once, and Enter plans a finished length at once, then moves on.
{
  const slow = kerfSource.replace(/function solveSheets\(mat, cfg, quick\) \{/, '$& if (!quick && !cfg.replay && P.materials.indexOf(mat) >= 0) { planned++; for (var t0 = performance.now(); performance.now() - t0 < 120;); }')
    .replace('<script>(function () {', '<script>var planned = 0;</script>$&');
  assert.ok(slow.includes('planned++'), 'the sheet solver isn’t where this test looks for it');
  const sc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const sp = await sc.newPage();
    sp.on('pageerror', e => problems.push('slow plans: ' + e.message));
    await sp.route(base, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: slow }));
    const cab = project('Cabinet', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 34.5, wid: 23.25 }, { name: 'Shelf', qty: 2, len: 33.75, wid: 22 }])]);
    await sp.goto(base + 'blank');
    await sp.evaluate(d => localStorage.setItem('kerf.v1', JSON.stringify(d)), { ...saved(cab), tab: 'list' });
    await sp.goto(base);
    await sp.waitForSelector('#planOut > *', { state: 'attached' });
    const len = sp.locator('.prow[data-pid] input[data-f="len"]').first();
    await len.fill('');
    await sp.waitForTimeout(1000);
    await sp.evaluate(() => { planned = 0; });
    for (const ch of '30 1/4') { await len.press(ch === ' ' ? 'Space' : ch); await sp.waitForTimeout(300); }
    assert.equal(await sp.evaluate(() => planned), 0, 'typing a slow material’s length at a phone’s pace planned it before the length was done');
    await sp.waitForTimeout(800);
    assert.equal(await sp.evaluate(() => planned), 1, 'the length typed wasn’t planned once typing stopped');
    await len.fill('');
    await sp.waitForTimeout(1000);
    await sp.evaluate(() => { planned = 0; });
    await len.pressSequentially('31');
    await len.press('Enter');
    assert.equal(await sp.evaluate(() => planned), 1, 'Enter didn’t plan the length at once');
    assert.equal(await sp.evaluate(() => document.activeElement.dataset.f), 'wid', 'Enter didn’t move on to the width');
    await sp.waitForTimeout(800);
    assert.equal(await sp.evaluate(() => planned), 1, 'the length was planned again after Enter');
  } finally { await sc.close(); }
}

// Deleting takes two separate taps: a double tap only asks.
{
  const keep = project('Keep me', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])]);
  const other = project('Other', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }]), board('1×4 board', [{ len: 96, price: 5.48 }], [{ name: 'Slat', qty: 2, len: 30 }])]);
  await open(saved(keep, other));
  await view('list');
  await page.dblclick('[data-a="delmat"] >> nth=0');
  assert.equal(await page.locator('#mats .mat').count(), 1, 'a double tap removed a material');
  await page.click('#projBtn');
  await page.dblclick('#sheet .btn.danger');
  assert.equal(await page.locator('#sheet .pitem').count(), 2, 'a double tap deleted the project');
  await page.waitForTimeout(600);
  await page.click('#sheet .btn.danger');
  assert.deepEqual((await stored()).order, [other.id], 'a second tap a moment later deletes it');
  assert.equal(await page.textContent('#toast'), 'Deleted “Keep me”Undo');
}

// Undo brings a deleted project back, in this window and in another one open beside it, which had already taken the
// deletion in: back where it was in the list, with its ticks, as the open project here. A deletion not undone still
// holds in both. Deleting the last project leaves the example in its place, and Undo takes that away again.
{
  const keep = project('Keep me', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 2, len: 30 }])], { done: {} });
  const first = project('First', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 3, len: 30 }])]);
  const last = project('Last', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 1, len: 30 }])]);
  await open({ ...saved(keep, first, last), current: keep.id, order: [first.id, keep.id, last.id] });
  await view('saw');
  await page.locator('#sawOut .cut[data-k]').first().click();
  const other = await ctx.newPage();
  other.on('pageerror', e => problems.push('second window: ' + e.message));
  await other.goto(base);
  await other.waitForSelector('#planOut > *', { state: 'attached' });
  const listed = async win => { await win.click('#projBtn'); const n = await win.$$eval('#sheet .pitem b', bs => bs.map(b => b.textContent)); await win.click('#pjx'); return n; };
  const deleteOpen = async () => { await page.click('#projBtn'); await page.click('#sheet .btn.danger'); await page.waitForTimeout(600); await page.click('#sheet .btn.danger'); };
  const otherHas = names => other.waitForFunction(n => JSON.stringify(Object.values(JSON.parse(localStorage.getItem('kerf.v1')).projects).map(p => p.name).sort()) === n, JSON.stringify(names.sort()), { timeout: 5000 });

  await deleteOpen();
  await otherHas(['First', 'Last']);
  assert.deepEqual(await listed(other), ['First', 'Last'], 'the other window still lists the deleted project');
  await page.click('#toast .lbtn');
  assert.equal(await page.textContent('#toast'), 'Brought back “Keep me”');
  assert.equal(await page.inputValue('#pname'), 'Keep me', 'Undo doesn’t open the project it brings back');
  assert.equal(await page.textContent('.saw-bar b'), '1 of 2 cuts', 'the project came back without its tick');
  assert.deepEqual((await stored()).order, [first.id, keep.id, last.id], 'the project came back somewhere else in the list');
  await other.waitForFunction(() => document.querySelector('#pjx') === null && localStorage.getItem('kerf.v1').includes('Keep me'), null, { timeout: 5000 });
  await other.waitForTimeout(100);
  assert.deepEqual((await listed(other)).sort(), ['First', 'Keep me', 'Last'], 'the other window doesn’t get the project back');
  await other.fill('#pname', 'First, renamed');
  await other.waitForFunction(() => localStorage.getItem('kerf.v1').includes('First, renamed'));
  assert.deepEqual(Object.values((await stored()).projects).map(p => p.name).sort(), ['First, renamed', 'Keep me', 'Last'], 'a save in the other window deleted it again');

  // Deleted and not undone, it stays deleted in both.
  await deleteOpen();
  await otherHas(['First, renamed', 'Last']);
  await page.waitForTimeout(100);
  await other.fill('#pname', 'First again');
  await other.waitForFunction(() => localStorage.getItem('kerf.v1').includes('First again'));
  await page.waitForFunction(() => document.getElementById('pname').value === 'First again');
  await page.fill('#pname', 'First, third');
  await page.waitForFunction(() => localStorage.getItem('kerf.v1').includes('First, third'));
  assert.deepEqual(Object.values((await stored()).projects).map(p => p.name).sort(), ['First, third', 'Last'], 'a deletion that wasn’t undone came back');
  assert.deepEqual((await listed(other)).sort(), ['First, third', 'Last']);
  await other.close();

  // The last project: deleted, the example takes its place; Undo, and the example goes again.
  await open(saved(last));
  await deleteOpen();
  assert.equal(await page.inputValue('#pname'), 'Garage shelves (example)');
  await page.click('#toast .lbtn');
  assert.deepEqual(Object.values((await stored()).projects).map(p => p.name), ['Last'], 'Undo left the example behind');
  assert.deepEqual(await listed(page), ['Last']);
}

// In mm a length in a field is the bare number, with the number pad: "1233.5", not "1233.5 mm" cut short on a phone.
{
  await open(saved(project('Metrisch', [board('45×90', [{ len: 2400 / 25.4, price: 6.5 }], [{ name: 'Bein', qty: 2, len: 1233.5 / 25.4 }]),
    sheet('18 mm plywood', [{ len: 2440 / 25.4, wid: 1220 / 25.4, price: 62 }], [{ name: 'Seite', qty: 1, len: 2033.5 / 25.4, wid: 1210 / 25.4 }])], { units: 'mm' })));
  await view('list');
  const fields = () => page.$$eval('#mats input.mono:not([data-f="qty"]):not([data-f="price"])', is => is.map(i => i.dataset.f + ' ' + i.value + ' ' + i.inputMode));
  // (the board's width and its part's, empty and hidden while the board has no width, get the number pad too)
  assert.deepEqual(await fields(), ['len 1233.5 decimal', 'wid  decimal', 'bwid  decimal', 'slen 2400 decimal', 'len 2033.5 decimal', 'wid 1210 decimal', 'slen 2440 decimal', 'swid 1220 decimal']);
  assert.deepEqual(await page.$$eval('.prow[data-pid] input[data-f="len"], .sheetmat .prow[data-pid] input[data-f="wid"]', is => is.map(i => i.placeholder)), ['900', '900', '400'], 'an mm length field’s example is broken');
  assert.equal(await page.getAttribute('[data-f="bwid"]', 'placeholder'), '140', 'an mm board width’s example');
  const len = page.locator('.prow[data-pid] input[data-f="len"]').first();
  await len.fill('1250');
  await len.blur();
  assert.equal(await len.inputValue(), '1250');
  await page.waitForTimeout(600);
  await view('plan');
  assert.match(await page.textContent('#planOut .steps'), /Bein · 2 × 1250 mm/, 'a bare number isn’t read as mm');
  // A sheet's size is in one unit, in the cut list's chips as in the plan: a chip read '1.22 m×2.44 m', and a
  // 610 × 1220 mm sheet '610 mm×1.22 m'.
  await view('list');
  assert.equal(await page.textContent('.sheetmat details.stock .chips .chip'), '1220 × 2440 mm · $62.00', 'a sheet’s chip mixes metres and millimetres');
  await view('plan');
  assert.ok((await page.$$eval('#planOut svg.diag text.dg-meta', ts => ts.map(t => t.textContent))).includes('1220 × 2440 mm'), 'the sheet’s heading isn’t in one unit');
  assert.match(await page.textContent('#planOut .shop'), /1 ×1220 × 2440 mm\$62\.00/, 'the shopping list doesn’t give the sheet in one unit');
}

// A price typed with a decimal comma means what it says, and a thousands comma still reads as one.
await open(saved(project('Komma', [board('45×90', [{ len: 2400 / 25.4, price: 6.5 }], [{ name: 'Bein', qty: 2, len: 700 / 25.4 }])], { units: 'mm', cur: '€' })));
await view('list');
await page.click('details.stock summary');
for (const [typed, shown] of [['4,28', '€4.28'], ['1.234,50', '€1234.50'], ['1,234', '€1234.00'], ['6.90', '€6.90']]) {
  await page.fill('.srow[data-sid] input[data-f="price"]', typed);
  assert.match(await page.textContent('details.stock .chips'), new RegExp(shown.replace('.', '\\.')), `a price typed as ${typed}`);
}

// The plan says why parts are left out: too big for any size listed, or more than the stock on hand can hold.
await open(saved(project('Left out', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 4, len: 72 }]),
  sheet('¾ plywood', [{ len: 96, wid: 48, have: 1 }], [{ name: 'Shelf', qty: 3, len: 90, wid: 40 }]),
  board('4×4', [{ len: 96, price: 11.98 }], [{ name: 'Post', qty: 1, len: 120 }])])));
assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¾ plywood: the sheets you have can’t hold Shelf × 2, so add a size to buy; 4×4 has 1 part too big for any size listed — see the cut list.');
// The 2×4s are still the cheapest possible, but not the whole plan: only they are named.
assert.equal(await page.textContent('.proved'), '2×4: cheapest possible');
await open(saved(project('Post too long', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 4, len: 72 }]), board('4×4', [{ len: 96, price: 11.98 }], [{ name: 'Post', qty: 1, len: 120 }])])));
assert.equal(await page.textContent('.proved'), '2×4: cheapest possible', 'a plan with every 4×4 part left out says it’s the cheapest possible');

// Kerf plans at most 300 of one sheet part: past that, the plan says parts are left out and the cut list says why.
await open(saved(project('Pegboard', [sheet('¼ plywood', [{ len: 96, wid: 48, price: 28 }], [{ name: 'Peg', qty: 400, len: 4, wid: 4, grain: false }])])));
assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¼ plywood has 1 part with more than 300 pieces — see the cut list.');
await view('list');
assert.equal(await page.textContent('.perr'), 'Peg × 400: Kerf plans at most 300 of one sheet part — split it into two rows.');

// A grain-locked sheet part that's too big either way round isn't told to "let it turn": turned, it fits no better.
// One that would fit turned is.
await open(saved(project('Tabletop', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }],
  [{ name: 'Huge tabletop', qty: 1, len: 100, wid: 50 }, { name: 'Cross panel', qty: 1, len: 40, wid: 60 }])])));
await view('list');
assert.equal(await page.textContent('.perr'), 'Huge tabletop (100″ × 50″) won’t fit on any sheet listed below. Add a bigger size. Cross panel (40″ × 60″) won’t fit on any sheet listed below with the grain along its length. Add a bigger size or let it turn.');

// On a phone the plan's "see the cut list" is a button: it opens the cut list at the first part left out, at the size
// that doesn't fit (the width when the length would), clear of the top bar. On a laptop, where the cut list is
// beside the plan, it's words. At the saw, with nothing to cut, a button goes to the cut list as well.
await open(saved({ ...project('Tabletop', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Shelf', qty: 1, len: 30, wid: 20 }, { name: 'Cross panel', qty: 1, len: 40, wid: 60 }])]) }));
{
  const focusedField = () => page.evaluate(() => { const a = document.activeElement; return a.closest('.prow').querySelector('[data-f="pname"]').value + ' ' + a.dataset.f; });
  const clear = () => page.evaluate(() => document.activeElement.getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom);
  assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¾ plywood has 1 part too big for any size listed — see the cut list.');
  await page.click('#planOut .warn button');
  assert.equal(await page.getAttribute('#tabs button[data-t="list"]', 'aria-current'), 'page', 'see the cut list doesn’t open the cut list');
  assert.equal(await focusedField(), 'Cross panel wid', 'see the cut list doesn’t go to the width that doesn’t fit');
  assert.ok(await clear(), 'the field is under the top bar');
  await page.fill('.prow[data-pid] input[data-f="wid"] >> nth=1', '30');
  await page.fill('.prow[data-pid] input[data-f="len"] >> nth=1', '100');
  await page.locator('.prow[data-pid] input[data-f="len"] >> nth=1').press('Enter');
  await view('plan');
  await page.click('#planOut .warn button');
  assert.equal(await focusedField(), 'Cross panel len', 'see the cut list doesn’t go to the length that doesn’t fit');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !document.querySelector('#planOut .warn button'), null, { timeout: 3000 }).catch(() => assert.fail('on a laptop "see the cut list" is still a button'));
  assert.match(await page.textContent('#planOut .warn'), /— see the cut list\.$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await view('plan');
  await page.waitForSelector('#planOut .warn button', { timeout: 3000 });
}
await open(saved(project('Too big', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Huge tabletop', qty: 1, len: 100, wid: 50 }])])));
await view('saw');
assert.equal(await page.textContent('#sawOut .empty'), 'The cutting steps show up here once there’s a plan.Go to the cut list');
await page.click('#sawOut .empty button');
assert.equal(await page.getAttribute('#tabs button[data-t="list"]', 'aria-current'), 'page', 'the saw’s button doesn’t open the cut list');

// An empty plan points to the cut list (a phone has no left side), and when every part is left out it says why.
await open(saved(project('Nothing yet', [])));
assert.match(await page.textContent('#planOut .empty'), /^Nothing to cut yet\.Add a material in the cut list, then the parts you need from it/);
await open(saved(project('Too long', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Beam', qty: 1, len: 120 }])])));
assert.equal((await page.textContent('#planOut')).replace(/^Plan/, ''), 'Some parts are left out. 2×4 has 1 part too big for any size listed — see the cut list.');
// Two boards on hand and nothing to buy: the two legs that fit are planned, and the third is said to be left out.
await open(saved(project('Short of legs', [board('Other board', [{ len: 96, have: 2 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. Other board: the boards you have can’t hold Leg × 1, so add a size to buy — see the cut list.');
assert.equal(await page.textContent('#planOut .mdiag h4'), 'Other board, 2 boards');

// A sheet's outline goes under its cut lines and numbers, not through them, on screen and in the PDF.
await open(null);
assert.ok(await page.evaluate(() => {
  const svg = [...document.querySelectorAll('#planOut svg.diag')].find(d => d.querySelector('.dg-num')), els = [...svg.children];
  return els.indexOf(svg.querySelector('rect.dg-pedge')) < els.indexOf(svg.querySelector('.dg-cut'));
}), 'the sheet outline is drawn over its cut numbers');
{
  const pdf = await shopPdf(), outline = pdf.search(/0\.62 0\.5 0\.32 RG 0\.8 w [\d. ]+ re S/);
  assert.ok(outline > 0 && outline < pdf.indexOf('0.14 0.38 0.8 RG 1 w [3 2] 0 d'), 'the PDF draws the sheet outline over its cut numbers');
}

// A board's length beside its drawing stays clear of the board, "600 mm" as well as "10'".
await open(saved(project('Metric offcuts', [board('45×90', [{ len: 2400 / 25.4, price: 9 }, { len: 600 / 25.4, have: 3 }], [{ name: 'Rail', qty: 2, len: 2000 / 25.4 }, { name: 'Block', qty: 3, len: 550 / 25.4 }])], { units: 'mm', kerf: 3 / 25.4 })));
{
  const clear = await page.$eval('#planOut svg.diag', svg => {
    const left = Math.min(...[...svg.querySelectorAll('rect.dg-wood')].map(r => r.getBBox().x));
    return [...svg.querySelectorAll('text.dg-meta')].filter(t => t.getAttribute('x') === '0').map(t => [t.textContent, t.getBBox().x + t.getBBox().width <= left - 2]);
  });
  assert.deepEqual(clear.map(c => c[0]), ['2.4 m ×2', '600 mm ×3']);
  assert.ok(clear.every(c => c[1]), 'a board\'s length runs into its drawing: ' + JSON.stringify(clear));
}

// An offcut's label fits inside the offcut: on a phone "keep 23 7/8\"" is too wide for it, so it shows the length alone.
await open(saved(project('Offcut', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 1, len: 72 }])])));
assert.deepEqual(await page.$$eval('#planOut .dg-scrapt', ts => ts.map(t => [t.textContent, t.getBBox().width <= t.previousElementSibling.width.baseVal.value - 2])), [['23 7/8″', true]], 'the offcut label');

// Muted labels read at 4.5:1 or better on the page, the cards and the grey strips, and offcut labels on their
// hatching, in light and dark.
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  const contrast = await page.evaluate(() => {
    const rgb = s => s.startsWith('#') ? [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) : s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = s => { const c = rgb(s).map(x => x / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const token = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const muted = getComputedStyle(document.querySelector('.total-lbl')).color, offcut = getComputedStyle(document.querySelector('.dg-scrapt')).fill;
    return { muted: Math.min(...['--surface', '--ground', '--surface2'].map(b => ratio(muted, token(b)))), offcut: ratio(offcut, token('--scrap')) };
  });
  assert.ok(contrast.muted >= 4.5, `muted labels are ${contrast.muted.toFixed(2)}:1 in ${scheme}`);
  assert.ok(contrast.offcut >= 4.5, `offcut labels are ${contrast.offcut.toFixed(2)}:1 on their hatching in ${scheme}`);
}
await page.emulateMedia({ colorScheme: null });

// At the saw, in light and dark: an empty tick box's edge stands out 3:1 from its card (WCAG 2.2, 1.4.11 Non-text
// Contrast) and a tick 4.5:1 from its green; a finished board isn't faded, its struck-through cuts still read 4.5:1;
// and in dark mode the pale blue saw cuts in the drawings get a dark edge against the wood.
await open(null);
await view('saw');
for (let i = 0; i < 3; i++) await cuts.nth(i).click();
await page.click('#sawOut .stk.done [data-fold]'); // board 1, finished and folded, opened
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  const c = await page.evaluate(() => {
    const rgb = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = s => { const c = rgb(s).map(x => x / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const cs = s => getComputedStyle(document.querySelector(s)), card = cs('.stk').backgroundColor;
    const on = cs('.cut[aria-checked="true"] .box');
    return { box: ratio(cs('.cut[aria-checked="false"] .box').borderTopColor, card), tick: ratio(on.color, on.backgroundColor), fade: cs('.stk.done').opacity,
      struck: ratio(cs('.stk.done .cut .what').color, card), under: cs('.dg-under').stroke };
  });
  assert.ok(c.box >= 3, `an empty tick box's edge is ${c.box.toFixed(2)}:1 in ${scheme}`);
  assert.ok(c.tick >= 4.5, `a tick is ${c.tick.toFixed(2)}:1 on its green in ${scheme}`);
  assert.equal(c.fade, '1', `a finished board is faded in ${scheme}`);
  assert.ok(c.struck >= 4.5, `a finished cut reads ${c.struck.toFixed(2)}:1 in ${scheme}`);
  assert.equal(c.under === 'none', scheme === 'light', `the dark edge under the saw cuts in ${scheme}: ${c.under}`);
}
await page.emulateMedia({ colorScheme: null });

// Forced colours (Windows High Contrast) drop backgrounds and recolour text: an empty tick box still shows no tick, and
// a ticked box, the tab that's on and a locked grain stand out from the page in the system's highlight colour.
await open(saved(project('Forced colours', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Shelf', qty: 2, len: 30, wid: 20 }, { name: 'Back', qty: 1, len: 30, wid: 20, grain: false }])])));
await view('saw');
await cuts.nth(0).click();
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme, forcedColors: 'active' });
  const f = await page.evaluate(() => {
    const rgb = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).join(','), cs = s => getComputedStyle(document.querySelector(s)), page = rgb(cs('body').backgroundColor);
    const off = cs('.cut[aria-checked="false"] .box'), on = cs('.cut[aria-checked="true"] .box');
    return { hidden: rgb(off.color) === rgb(cs('.stk').backgroundColor), edge: rgb(off.borderTopColor) !== rgb(cs('.stk').backgroundColor), ticked: rgb(on.backgroundColor) !== page,
      tab: rgb(cs('#tabs button.on').backgroundColor) !== page, grain: rgb(cs('.grain[aria-pressed="true"]').backgroundColor) !== rgb(cs('.grain[aria-pressed="false"]').backgroundColor) };
  });
  assert.deepEqual(f, { hidden: true, edge: true, ticked: true, tab: true, grain: true }, `under forced colours in ${scheme}`);
}
await page.emulateMedia({ colorScheme: null, forcedColors: null });

// Kerf plans up to 500 of a board part. A count of 600 stays 600, and the cut list and the plan say 100 are left out
// (it used to become 500 when you left the field, without a word, and the plan bought for 500). A count past what a
// field holds is marked, and becomes 9999 when you leave it. A link or file asking for more says so where it opens.
await open(saved(project('Pegs', [board('1×2', [{ len: 96, price: 2.98 }], [{ name: 'Peg', qty: 2, len: 3 }])])));
await view('list');
{
  const qty = page.locator('.prow[data-pid] input[data-f="qty"]');
  await qty.fill('600');
  assert.equal(await qty.evaluate(e => e.classList.contains('bad')), false, '600 is marked as a mistake');
  await qty.blur();
  assert.equal(await qty.inputValue(), '600', 'the count typed was changed');
  await page.waitForFunction(() => !document.querySelector('.mat .perr').hidden);
  assert.equal(await page.textContent('.mat .perr'), 'Peg × 600: Kerf plans at most 500 of one board part — split it into two rows.');
  await view('plan');
  assert.match(await page.textContent('#planOut .warn'), /1×2 has 1 part with more than 500 pieces — see the cut list/);
  await view('list');
  await qty.fill('12000');
  assert.ok(await qty.evaluate(e => e.classList.contains('bad')), '12000 isn\'t marked');
  await qty.blur();
  assert.deepEqual([await qty.inputValue(), await qty.evaluate(e => e.classList.contains('bad'))], ['9999', false]);
  const many = { kerf: 1, project: { ...MUDROOM.project, name: 'Fence', materials: [
    { ...MUDROOM.project.materials[0], parts: [{ name: 'Picket', qty: 600, len: 30 }] },
    { ...MUDROOM.project.materials[1], parts: [{ name: 'Tile', qty: 400, len: 4, wid: 4, grain: false }] }] } };
  await page.goto('about:blank');
  await page.goto(base + linkTo(many));
  await page.waitForSelector('#lkAdd');
  assert.deepEqual(await page.$$eval('#sheet .note', ns => ns.map(n => n.textContent).slice(0, 2)), [
    'Picket × 600: Kerf plans at most 500 of one board part — split it into two rows.',
    'Tile × 400: Kerf plans at most 300 of one sheet part — split it into two rows.'], 'a link asking for more than Kerf plans doesn’t say so');
  await page.click('#lkAdd');
  await view('list');
  assert.deepEqual(await page.$$eval('.prow[data-pid] input[data-f="qty"]', is => is.map(i => i.value)), ['600', '400'], 'the counts from the link were changed');
}

// The units switch in Settings is as wide as its two buttons, not the whole dialog.
await page.click('#setBtn');
assert.ok(await page.$eval('#uSeg', seg => seg.getBoundingClientRect().width <= [...seg.children].reduce((w, b) => w + b.getBoundingClientRect().width, 0) + 4), 'the units switch stretches across Settings');
await page.keyboard.press('Escape');

// Printed, the page leaves out the junkdrawer.works footer; with JavaScript off, it says what it needs it for.
await page.emulateMedia({ media: 'print' });
assert.ok(await page.isHidden('.jd-foot'), 'the footer prints');
await page.emulateMedia({ media: null });
{
  const off = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const p = await off.newPage();
  await p.goto(base);
  assert.equal(await p.locator('.noscript').textContent().catch(() => null), 'Kerf needs JavaScript to work out what to buy and how to cut it.');
  assert.ok(await p.isVisible('.noscript'));
  await off.close();
}

// A board's last part comes off without a cut only when it's all that's left. Two 47 7/8" rails from an 8' board
// (the planner's advice) leave 48" after the first cut, so the second rail is measured and cut too.
// With end trim, the first part is measured from the squared end, and an offcut is longer on the bench than once squared.
const RAIL = 'Measure from the end, cut on the waste side of the mark', FRESH = 'Measure from the fresh end', SQUARED = 'Measure from the squared end, cut on the waste side of the mark';
const TRIM = q => `Trim off ${q} and measure every part from this fresh end`;
const sawCases = [
  { trim: 0, parts: [{ name: 'Rail', qty: 2, len: 47.875 }], steps: [RAIL, FRESH], cuts: 2, lines: 2 },
  { trim: 0, parts: [{ name: 'Rail', qty: 2, len: 47 + 15 / 16 }], steps: [RAIL], note: 'What’s left should be A Rail (47 15⁄16″). Measure it, and trim it if the board ran long.', cuts: 1, lines: 1 },
  { trim: 0.25, parts: [{ name: 'Rail', qty: 2, len: 47 + 11 / 16 }], steps: [TRIM('1⁄4″'), SQUARED, FRESH + ' — this cut squares up the far end too'], cuts: 3, lines: 2 },
  { trim: 0.25, parts: [{ name: 'Top', qty: 1, len: 95.5 }], steps: [TRIM('1⁄4″'), SQUARED + ' — this cut squares up the far end too'], cuts: 2, lines: 1 },
  { trim: 0, parts: [{ name: 'Top', qty: 1, len: 96 }], steps: [], note: 'The whole board is A Top — no cut needed', cuts: 0, lines: 0 },
  { trim: 0, parts: [{ name: 'Leg', qty: 1, len: 72 }], steps: [RAIL], note: 'Leaves a 23 7⁄8″ offcut — worth keeping', cuts: 1, lines: 1, pdf: 'keep 23 7/8"' },
  { trim: 0.5, parts: [{ name: 'Leg', qty: 1, len: 72 }, { name: 'Brace', qty: 1, len: 20 }], steps: [TRIM('1⁄2″'), SQUARED, FRESH], note: 'Leaves a 3 1⁄4″ offcut (2 3⁄4″ once its end is squared)', cuts: 3, lines: 2 },
  { trim: 0.5, parts: [{ name: 'Slat', qty: 1, len: 47.5 }], steps: [TRIM('1⁄2″'), SQUARED], note: 'Leaves a 47 7⁄8″ offcut (47 3⁄8″ once its end is squared) — worth keeping', cuts: 2, lines: 1 },
];
for (const c of sawCases) {
  await open(saved(project('Saw', [board('2×4', [{ len: 96, price: 4.28 }], c.parts)], { trim: c.trim })));
  const what = `${c.parts[0].qty} × ${c.parts[0].len} on 8', trim ${c.trim}`;
  assert.equal(await cutsFact(), c.cuts + (c.cuts === 1 ? 'cut' : 'cuts'), what + ': cuts in the plan');
  assert.equal(await page.locator('#planOut .dg-kerf').count(), c.lines, what + ': saw cuts drawn');
  const pdf = await shopPdf();
  assert.equal(pdfKerfLines(pdf), c.lines, what + ': saw cuts in the PDF');
  if (c.pdf) assert.ok(pdfRuns(pdf).some(r => r.text === c.pdf), what + ': the offcut in the PDF');
  await view('saw');
  assert.deepEqual(await sawSteps(), c.steps, what + ': steps at the saw');
  assert.equal(await page.textContent('.saw-bar b'), `0 of ${c.cuts} ${c.cuts === 1 ? 'cut' : 'cuts'}`, what + ': cuts at the saw');
  if (c.note) assert.equal(shown(await page.textContent('#sawOut .cut.note')), c.note, what + ': the note at the saw');
  // a note reads as a line of text, its fractions typeset in it, not spread out like the parts of a cut's row
  assert.ok(await page.$$eval('#sawOut .cut.note', ns => ns.every(n => n.childNodes.length === 1 && n.firstChild.tagName === 'SPAN')), what + ': a note at the saw is spread out');
}

// The saw's bar, with its count, stays in sight under the top bar as the cuts scroll by, and its Next cut goes to the
// next cut and focuses it. Once every cut is ticked there's no next cut, and no button for it.
{
  await open(null);
  await view('saw');
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(100);
  const at = () => page.evaluate(() => { const b = document.querySelector('.saw-bar').getBoundingClientRect(); return [Math.round(b.top), Math.round(document.querySelector('.top').getBoundingClientRect().bottom), Math.round(b.height), parseFloat(getComputedStyle(document.querySelector('#sawOut')).getPropertyValue('--sb'))]; });
  const [top, under, h, sb] = await at();
  assert.ok(Math.abs(top - under) <= 1 && Math.abs(h - sb) <= 1, 'the saw’s bar scrolls away, or --sb isn’t its height: ' + [top, under, h, sb]);
  await page.click('#sawNext');
  await page.waitForFunction(() => document.activeElement.matches('.cut.next'));
  await page.waitForTimeout(800); // a smooth scroll
  assert.ok(await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(), b = document.querySelector('.saw-bar').getBoundingClientRect(); return r.top >= b.bottom && r.bottom <= innerHeight; }), 'Next cut doesn’t bring the next cut into sight');
  await fitsPhone('saw with Next cut');
  const left = page.locator('#sawOut .cut[data-k][aria-checked="false"]');
  while (await left.count()) await left.first().click();
  assert.equal(await page.$('#sawNext'), null, 'a finished job still offers Next cut');
}

// At the saw a sheet's card is headed with its material and starts with the sheet's drawing, its next cut standing out
// (a yellow line and number) and the cuts ticked faded; each cut gives its number in the drawing. "Drawing" folds it
// away, and it stays folded through a tick. Boards keep to text.
{
  await open(null);
  await view('saw');
  const sheetCard = page.locator('#sawOut .stk').filter({ has: page.locator('.sdg') });
  assert.equal(await page.locator('#sawOut .sdg').count(), 1, 'only the sheet has a drawing at the saw');
  assert.equal((await sheetCard.locator('.stk-hd b').textContent()).replace(/\u00a0/g, ' '), '¾ plywood · Sheet 1', 'the sheet card’s heading');
  const drawn = () => sheetCard.evaluate(c => ({ next: [...c.querySelectorAll('.dg-numt.nx')].map(t => t.textContent), lines: c.querySelectorAll('.dg-cut.nx').length, faded: [...c.querySelectorAll('.dg-numt.dn')].map(t => t.textContent), open: c.querySelector('.sdg').open }));
  assert.deepEqual(await drawn(), { next: ['1'], lines: 1, faded: [], open: true }, 'the sheet’s drawing at the saw');
  assert.deepEqual(await sheetCard.locator('.cut[data-k] .cn').evaluateAll(ns => ns.map(n => n.dataset.n)), ['1', '2', '3', '4', '5', '6'], 'the sheet’s cuts give their numbers in the drawing');
  await sheetCard.locator('.cut[data-k]').first().click();
  assert.deepEqual(await drawn(), { next: ['2'], lines: 1, faded: ['1'], open: true }, 'the drawing after a tick');
  await sheetCard.locator('.sdg summary').click();
  await sheetCard.locator('.cut[data-k]').nth(1).click();
  assert.deepEqual(await drawn(), { next: ['3'], lines: 1, faded: ['1', '2'], open: false }, 'the drawing folded away stays folded through a tick');
  await fitsPhone('saw with a sheet’s drawing');
  // the drawing's labels and numbers sit where the plan's do: the same picture, but for its heading and marks
  await page.setViewportSize({ width: 1280, height: 800 });
  await sheetCard.locator('.sdg summary').click();
  await page.waitForTimeout(300);
  assert.ok(await sheetCard.evaluate(c => c.querySelector('.sdg svg').getBoundingClientRect().width <= 721), 'the saw’s drawing grows past 720 px on a laptop');
  await page.setViewportSize({ width: 390, height: 844 });
  // With the factory edges to trim first, that's the next cut, and it isn't in the drawing: no cut stands out until it's ticked.
  await open(saved(project('Edges', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 30.25, wid: 23.75 }])], { edge: 0.25 })));
  await view('saw');
  assert.deepEqual(await drawn(), { next: [], lines: 0, faded: [], open: true }, 'a cut stands out in the drawing while the edges are still to trim');
  await sheetCard.locator('.cut[data-k]').first().click();
  assert.deepEqual(await drawn(), { next: ['1'], lines: 1, faded: [], open: true }, 'the drawing once the edges are trimmed');
}

// The shop PDF is a checklist for the saw on paper: a box to tick before every cut, the same cuts the saw counts. Under
// each row of boards cut alike come its cuts in order, a box for each board (numbered over them), its measurement and
// its part; a run of more than 16 gets one box and its count. A sheet's steps each start with a box, its trims too.
{
  const boxes = pdf => (pdf.match(/1 1 1 rg 0\.11 0\.12 0\.13 RG 0\.8 w [\d. ]+ 8 8 re B/g) || []).length;
  await open(null);
  let raw = await shopPdf(), pdf = pdfRuns(raw).map(r => r.text);
  assert.equal(boxes(raw), 26, 'the example’s PDF has a box for each of its 26 cuts');
  const at = pdf.indexOf('1\x964'), cuts = pdf.slice(at, pdf.indexOf('5\x968'));
  assert.deepEqual(cuts.slice(cuts.indexOf('4') + 1), ['48"', 'B Front & back rail', '48"', 'B Front & back rail', '21"', 'C Side rail'], 'boards 1–4’s cuts in order on the PDF: ' + cuts.join(' / '));
  assert.deepEqual(cuts.filter(t => /^\d$/.test(t)), ['1', '2', '3', '4'], 'boards 1–4 numbered over their boxes');
  assert.ok(pdf.includes('1.  Rip the full sheet at 23 3/4"'), 'the sheet’s steps on the PDF');
  await open(saved(project('Posts', [board('2×4', [{ len: 96, price: 4 }], [{ name: 'Post', qty: 40, len: 45 }])], { trim: 0.25 })));
  raw = await shopPdf(); pdf = pdfRuns(raw).map(r => r.text);
  assert.ok(pdf.includes('\xd720') && pdf.includes('Square up one end, and measure every part from it'), 'a run of 20 boards on the PDF: ' + pdf.slice(0, 30).join(' / '));
  assert.equal(boxes(raw), 3, 'a run of 20 boards gets one box for each cut: the end, and two posts');
  await open(saved(project('Edges', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 30.25, wid: 23.75 }])], { edge: 0.25 })));
  await view('saw');
  const sawCuts = await page.locator('#sawOut .cut[data-k]').count();
  raw = await shopPdf();
  assert.equal(boxes(raw), sawCuts, 'the trimmed sheet’s boxes on the PDF, its edges first, as the cuts at the saw');
}

// The offcuts worth keeping are gathered under the shopping list, alike ones counted together, and on the shop PDF;
// at the saw they show again once the last cut is ticked.
{
  await open(saved(project('Keepers', [board('2×4', [{ len: 96, price: 4 }], [{ name: 'Leg', qty: 2, len: 72 }]), sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 30.25, wid: 23.75 }])])));
  const line = '2 × 23 7⁄8″ 2×4, 1 × 96″ × 24 1⁄8″ ¾ plywood, 1 × 35 1⁄4″ × 23 3⁄4″ ¾ plywood';
  assert.equal(shown(await page.textContent('#planOut .keeps')), 'Offcuts worth keeping: ' + line, 'the offcuts worth keeping in the plan');
  const pdf = pdfRuns(await shopPdf()).map(r => r.text).join(' ');
  assert.ok(pdf.includes('Offcuts worth keeping: 2 × 23 7/8" 2×4, 1 × 96" × 24 1/8" ¾ plywood, 1 × 35 1/4" × 23 3/4" ¾ plywood'.replace(/×/g, '\xd7').replace(/¾/g, '\xbe')), 'the offcuts worth keeping on the shop PDF: ' + pdf.slice(0, 400));
  await view('saw');
  assert.equal(await page.$('#sawOut .keeps'), null, 'the offcuts worth keeping show at the saw before the job is done');
  const left = page.locator('#sawOut .cut[data-k][aria-checked="false"]');
  while (await left.count()) await left.first().click();
  assert.match(await page.textContent('.saw-bar b'), /^All \d+ cuts done$/);
  assert.equal(shown(await page.textContent('#sawOut .keeps')), 'Offcuts worth keeping: ' + line, 'the offcuts worth keeping once the last cut is ticked');
  await fitsPhone('saw with the offcuts worth keeping');
  // a plan with none says nothing
  await open(null);
  assert.equal(await page.$('#planOut .keeps'), null, 'the example has no offcut worth keeping');
}

// A rip wider than what's left past the blade gives the fence setting for that too, for a saw whose fence can't go that
// far: 31 1/4" off a 48" sheet leaves 16 5/8" past an 1/8" kerf. A rip narrower than what's left has no such line, and
// nor has one that leaves less than an inch, a strip that would be trapped between the blade and the fence. A rip that
// gives a strip to cut again names the strip.
{
  const second = async parts => {
    await open(saved(project('Wide rip', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], parts)])));
    await view('saw');
    return page.$$eval('#sawOut .cut[data-k] .what', ws => ws.map(w => w.querySelectorAll('small')[1]?.textContent || '')).then(a => a.map(shown));
  };
  assert.deepEqual(await second([{ name: 'Door', qty: 2, len: 30, wid: 31.25 }]), ['or set the fence at 16 5⁄8″ — the 31 1⁄4″ piece is the one past the blade', '', ''], 'a wide rip that gives a strip');
  assert.deepEqual(await second([{ name: 'Panel', qty: 1, len: 96, wid: 47.5 }]), [''], 'a rip that leaves 3/8" gives no fence setting for it');
  await open(saved(project('Wide rip', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Top', qty: 1, len: 96, wid: 31.25 }, { name: 'Shelf', qty: 1, len: 96, wid: 6 }])])));
  await view('saw');
  const rows = await page.$$eval('#sawOut .cut[data-k] .what', ws => ws.map(w => [...w.querySelectorAll('small')].map(s => s.textContent))).then(a => a.map(r => r.map(shown)));
  assert.deepEqual(rows, [
    ['Along the grain — set the fence at 31 1⁄4″, or mark it and cut on the waste side', 'or set the fence at 16 5⁄8″ — the part is the piece past the blade'],
    ['Along the grain — set the fence at 6″, or mark it and cut on the waste side']], 'the wide rip’s fence settings at the saw');
  await fitsPhone('saw with a wide rip');
}

// A sheet's steps name the piece each cut is made on, typeset like the measurements; a rip says where to set the fence
// and a crosscut to measure from the end, both to cut on the waste side; and a piece worth keeping gets a note. The
// shop PDF writes the same steps in plain text.
{
  await open(saved(project('Sides', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Side', qty: 2, len: 30.25, wid: 23.75 }])])));
  assert.deepEqual(await page.$$eval('#planOut ol.steps li > span', ls => ls.map(l => l.textContent)).then(a => a.map(shown)), ['Rip the full sheet at 23 3⁄4″', 'Crosscut the 96″ × 23 3⁄4″ strip at 30 1⁄4″ → A Side', 'Crosscut the 65 5⁄8″ × 23 3⁄4″ piece at 30 1⁄4″ → A Side']);
  const raw = await shopPdf(), pdf = pdfRuns(raw).map(r => r.text);
  assert.ok(pdf.includes('2.  Crosscut the 96" × 23 3/4" strip at 30 1/4"  »  A Side'), 'the PDF\'s sheet steps: ' + pdf.filter(t => /^\d\./.test(t)));
  // Printed in black and white, parts are white and waste is hatched, not three tans and greys that print alike; the
  // piece left over is labelled with its size, as on screen.
  assert.ok(pdf.includes('96" × 24 1/8"'), 'no size on the piece left over in the PDF');
  assert.ok(!/0\.92 0\.83 0\.65 rg|0\.91 0\.84 0\.7 rg|0\.8 0\.82 0\.79 rg/.test(raw) && / re W n /.test(raw), 'the PDF fills parts and waste in colours that print as the same grey');
  await view('saw');
  assert.deepEqual(await page.$$eval('#sawOut .cut[data-k] .what', ws => ws.map(w => w.textContent.replace(/^Next /, ''))).then(a => a.map(shown)), [
    'Rip the full sheetAlong the grain — set the fence at 23 3⁄4″, or mark it and cut on the waste side',
    'Crosscut the 96″ × 23 3⁄4″ strip → A SideAcross the grain — measure from the end, cut on the waste side',
    'Crosscut the 65 5⁄8″ × 23 3⁄4″ piece → A SideAcross the grain — measure from the end, cut on the waste side']);
  assert.equal(shown(await page.textContent('#sawOut .cut.note')), 'Leaves a 96″ × 24 1⁄8″ piece and a 35 1⁄4″ × 23 3⁄4″ piece — worth keeping');

  // Trim sheet edges, in Settings: the saw starts the sheet by trimming its factory edges, counted as a cut by the saw
  // and the plan alike, the plan's steps and the shop PDF say so first, and the cuts are made on the trimmed sheet.
  // A part that fits only with the edges left on says so.
  await page.click('#setBtn');
  await page.fill('#sEdge', '1/4');
  await page.click('#sKeep');
  assert.equal(await page.inputValue('#sEdge'), '1/4"', 'Trim sheet edges reads back');
  await page.click('#stx');
  await page.waitForTimeout(600);
  assert.equal(parseInt(await cutsFact()), 4, 'the plan counts the trim as a cut');
  assert.equal(shown(await page.textContent('#planOut .steps-first')), 'First trim 1⁄4″ off each factory edge, leaving 47 1⁄2″ × 95 1⁄2″. Every cut is measured from a trimmed edge.');
  assert.match(shown(await page.textContent('#planOut ol.steps li > span')), /^Rip the trimmed sheet at 23 3⁄4″/);
  const edged = pdfRuns(await shopPdf()).map(r => r.text);
  assert.ok(edged.some(t => /^First trim 1\/4" off each factory edge, leaving 47 1\/2" × 95 1\/2"\./.test(t)), 'the PDF doesn’t say to trim the edges first: ' + edged.filter(t => /trim/i.test(t)));
  assert.ok(edged.some(t => /^Saw kerf 1\/8" · sheet edges 1\/4" · /.test(t)), 'the PDF header doesn’t give the sheet edges');
  await view('saw');
  assert.equal(await page.textContent('.saw-bar b'), '0 of 4 cuts');
  assert.deepEqual([shown(await page.textContent('#sawOut .cut[data-k] .meas')), shown(await page.textContent('#sawOut .cut[data-k] .what'))],
    ['1⁄4″', 'Next Trim the factory edgesTake 1⁄4″ off each edge, leaving 47 1⁄2″ × 95 1⁄2″, and measure every cut from a trimmed edge']);
  await view('list');
  await page.locator('#mats .prow[data-pid] input[data-f="len"]').first().fill('96');
  await page.waitForTimeout(600);
  assert.match(await page.textContent('[data-err]:not([hidden])'), /^Side \(96″ × 23.3\/4″\) won’t fit on any sheet listed below once its edges are trimmed\. Add a bigger size or trim less off sheet edges in Settings\.$/);
}

// At the saw a measurement's fraction is nearly as big as its whole inches, and every row's text starts at the same
// place, 47 15/16" or 9 1/2", 1213.5 mm or 150 mm.
for (const [units, len, short] of [['in', 47 + 15 / 16, 9.5], ['mm', 1213.5 / 25.4, 150 / 25.4]]) {
  await open(saved(project('Columns', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Rail', qty: 1, len }, { name: 'Cleat', qty: 2, len: short }])], { units })));
  await view('saw');
  const rows = await page.$$eval('#sawOut .cut[data-k]', els => els.map(e => {
    const m = e.querySelector('.meas'), fr = m.querySelector('.fr');
    return { left: e.querySelector('.what').getBoundingClientRect().left, fits: m.scrollWidth <= m.clientWidth, fr: fr ? parseFloat(getComputedStyle(fr).fontSize) / parseFloat(getComputedStyle(m).fontSize) : 1 };
  }));
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.left === rows[0].left && r.fits), `the rows' text doesn't line up in ${units}: ${JSON.stringify(rows)}`);
  assert.ok(rows.every(r => r.fr >= 0.8), `a fraction at the saw is small in ${units}`);
}

// A board ripped into narrower parts: a face frame from a 1×6, two 1 1/2" stiles and three rails ripped from it and a
// shelf the board's width. The cut list shows the parts' widths (a blank one shows the board's), the plan draws a board
// that rips and crosscuts, the saw says "the board", ticks stay through a reload, and the shop PDF has the board. With
// the board's width taken away, its parts' widths hide and it's planned as plain boards again; a part wider than the
// board says so.
{
  await open(saved(project('Face frame', [{ ...board('1×6 board', [{ len: 72, price: 6.28 }, { len: 96, price: 8.28 }], [{ name: 'Stile', qty: 2, len: 30, wid: 1.5 }, { name: 'Rail', qty: 3, len: 20, wid: 1.5 }, { name: 'Shelf', qty: 1, len: 30 }]), wid: 5.5 }])));
  assert.equal(await page.textContent('.total'), '$8.28');
  assert.equal(await page.textContent('#planOut .mdiag h4'), '1×6 board, 1 board');
  assert.match(await page.textContent('#planOut .mdiag svg'), /^Board 18′ · 5 1\/2″ wide/);
  assert.equal(shown(await page.textContent('#planOut .steps li')), '1Crosscut the board at 30″ → C Shelf');
  assert.ok((await page.$$eval('#planOut .mdiag .steps li', ls => ls.map(l => l.textContent))).some(t => /Rip the .* at 1 1⁄2″/.test(shown(t))), 'the plan has no rip at 1 1/2"');
  assert.match(shown(await page.textContent('#planOut .mdiag')), /Stile · 2 × 30″ × 1 1⁄2″/);
  await fitsPhone('ripped board plan');
  const pdf = pdfRuns(await shopPdf()).map(r => r.text);
  assert.ok(pdf.includes('Board 1') && pdf.some(t => /^1\.  Crosscut the board at 30"/.test(t)) && pdf.some(t => /Rip the .* at 1 1\/2"/.test(t)), 'the shop PDF’s ripped board: ' + pdf.filter(t => /Board|Rip|Crosscut/.test(t)).join(' / '));
  await view('saw');
  assert.equal(await page.textContent('#sawOut .stk-hd b'), 'Board 1');
  const sawCuts = page.locator('#sawOut .cut[data-k]');
  assert.match(shown(await sawCuts.nth(0).locator('.what').textContent()), /^Next Crosscut the board → C ShelfAcross the grain/);
  await sawCuts.nth(0).click(); await sawCuts.nth(1).click();
  assert.equal(await page.textContent('.saw-bar b'), '2 of 8 cuts');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#sawOut .cut[data-k]');
  assert.equal(await page.textContent('.saw-bar b'), '2 of 8 cuts', 'a ripped board’s ticks don’t survive a reload');
  await view('list');
  const widths = () => page.$$eval('.prow[data-pid] [data-f="wid"]', is => is.map(i => i.getClientRects().length ? i.value + '|' + i.placeholder : 'hidden'));
  assert.deepEqual(await widths(), ['1 1/2"|5 1/2"', '1 1/2"|5 1/2"', '|5 1/2"']);
  // Enter goes along a board part to its width, then the next part.
  await page.locator('.prow[data-pid] [data-f="len"]').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.f), 'wid');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'Rail');
  // No board width: the widths hide and the board is planned as plain boards (the stiles from the whole width).
  await page.click('details.stock summary');
  await page.fill('[data-f="bwid"]', '');
  await page.locator('[data-f="bwid"]').press('Enter');
  assert.deepEqual(await widths(), ['hidden', 'hidden', 'hidden']);
  await view('plan');
  await page.waitForFunction(() => document.querySelector('.total').textContent !== '$8.28', null, { timeout: 5000 }).catch(() => {});
  assert.equal(await page.textContent('.total'), '$14.56', 'without its width the 1×6 isn’t planned as plain boards');
  await view('list');
  await page.fill('[data-f="bwid"]', '5 1/2');
  await page.locator('[data-f="bwid"]').press('Enter');
  assert.deepEqual(await widths(), ['1 1/2"|5 1/2"', '1 1/2"|5 1/2"', '|5 1/2"']);
  // A part wider than the board says so.
  await page.fill('.prow[data-pid] [data-f="wid"] >> nth=0', '7');
  await page.locator('.prow[data-pid] [data-f="wid"] >> nth=0').press('Enter');
  await page.waitForFunction(() => !document.querySelector('.perr').hidden, null, { timeout: 5000 });
  assert.equal(await page.textContent('.perr'), 'Stile (7″ wide) is wider than the board (5\u00a01/2″). Make it narrower, or the board wider in its sizes below.');
  await fitsPhone('ripped board cut list');
}

// Boards on hand that run short say so in the cut list, instead of stopping the page: which parts are left out, and
// how many.
await open(saved(project('Short of legs', [board('Other board', [{ len: 96, have: 2 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
await view('list');
assert.equal(await page.textContent('.perr'), 'The boards you have can’t hold every part: Leg × 1 (72″) is left out of the plan. Add a size to buy that fits it.');

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');

await ctx.close();

// Works offline once it has been opened, in a window of its own that has been to Kerf once, so the copy holds only what
// sw.js keeps for it (by the end of a long session the worker has kept everything it fetched, and a file left out of
// its list would pass). The server goes down as well as the browser: in some Chromium builds the browser's offline
// switch alone doesn't stop the worker's own requests, and this passed with no copy at all.
const waitFor = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};
{
  const oc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const op = await oc.newPage();
  const trouble = [];
  op.on('pageerror', e => trouble.push(e.message));
  op.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) trouble.push(m.text()); });
  op.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('blob:')) trouble.push('left the site: ' + u); });
  await op.goto(base);
  await op.waitForSelector('#planOut > *', { state: 'attached' });
  await op.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });

  // With no network at all: the example, every typeface, a link, a project file and the shop PDF.
  net = 'down';
  await oc.setOffline(true);
  await op.reload();
  await op.waitForSelector('#planOut > *', { state: 'attached' });
  assert.equal(await op.textContent('.total'), '$100.64', 'the example did not open offline');
  const faces = await op.evaluate(async () => {
    await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));
    return [...document.fonts].map(f => `${f.family} ${f.weight} ${f.status}`);
  });
  assert.equal(faces.length, 6, 'Kerf has six typefaces: ' + faces.join(', '));
  assert.deepEqual(faces.filter(f => !f.endsWith(' loaded')), [], 'a typeface did not load offline');
  await op.goto('about:blank');
  await op.goto(base + linkTo(MUDROOM));
  await op.waitForSelector('#lkAdd', { timeout: 5000 }).catch(() => assert.fail('a link did not open offline'));
  await op.click('#lkAdd');
  assert.equal(await op.textContent('.total'), '$70.76', 'the project from a link did not plan offline');
  await op.click('#projBtn');
  await op.setInputFiles('#pjFile', { name: 'garage-bench.kerf.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ kerf: 1, project: { ...MUDROOM.project, name: 'Garage bench' } })) });
  await op.waitForSelector('#lkAdd', { timeout: 5000 }).catch(() => assert.fail('a project file did not open offline'));
  await op.click('#lkAdd');
  await op.waitForFunction(() => document.getElementById('pname').value === 'Garage bench');
  const [dl] = await Promise.all([op.waitForEvent('download', { timeout: 10000 }), op.click('#pdfBtn')]);
  assert.match((await readFile(await dl.path())).toString('latin1', 0, 8), /^%PDF-/, 'the shop PDF did not save offline');
  await oc.setOffline(false);

  // On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
  // the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
  net = 'stalled';
  const t0 = Date.now();
  await op.reload({ timeout: 10000 }).catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
  await op.waitForSelector('#planOut > *', { state: 'attached', timeout: 2000 }).catch(() => assert.fail('the page did not open on a stalled connection'));
  assert.equal(await op.inputValue('#pname'), 'Garage bench', 'the page did not open on a stalled connection');
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);

  // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
  // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
  release = true;
  await op.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await waitFor(() => op.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
    10000, "the new release's offline copy kept the old index.html");
  release = false;
  assert.deepEqual(trouble, [], 'problems offline');
  await oc.close();
}

// It can be installed: Chromium finds nothing missing from the manifest, its icons or the worker, at laptop size.
{
  const ic = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ip = await ic.newPage();
  await ip.goto(base);
  await ip.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
  const cdp = await ic.newCDPSession(ip);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installabilityErrors, [], 'Chromium says Kerf can’t be installed');
  const manifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, [], 'the manifest has errors');
  assert.equal(JSON.parse(manifest.data).name, 'Kerf');
  await ic.close();
}
await browser.close();
server.close();

// Every file the page and the manifest load is kept for offline: each font, icon and script index.html names, and
// each icon in manifest.webmanifest, is in sw.js's SHELL.
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
{
  const named = [...kerfSource.matchAll(/(?:href|src)="([^"]+)"|url\(([^)]+)\)/g)].map(m => m[1] || m[2]).filter(u => !/^(#|[a-z]+:)/.test(u));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'));
  named.push(...manifest.icons.map(i => i.src));
  assert.ok(named.length > 10, 'found too few files named in index.html: ' + named.join(', '));
  assert.deepEqual([...new Set(named)].filter(u => !shell.includes(u)), [], 'files the page loads that sw.js doesn’t keep for offline');
}

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
{
  const all = createHash('sha1');
  for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
  const files = all.digest('hex').slice(0, 8);
  assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
}
console.log('kerf e2e: all passed');
