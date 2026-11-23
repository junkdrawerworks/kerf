// Uses Kerf in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Opens the example project, a link and a project file from the kerf-planner skill, works through cuts
// at the saw, and checks it all on a phone with nothing loaded from elsewhere, then once more offline.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // A page on the same address that isn't Kerf, for putting things in storage before Kerf starts.
  if (path === '/blank') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>blank</title>'); return; }
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
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
const sawSteps = () => page.$$eval('#sawOut .cut[data-k]', els => els.map(e => e.querySelector('small').textContent));
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
assert.match(await page.textContent('.facts'), /8\s*boards\s*1\s*sheet\s*27\s*cuts/);
await fitsPhone('plan');
await view('list');
await fitsPhone('cut list');
await view('saw');
await fitsPhone('saw checklist');

// Ticks at the saw are kept: three cuts done, a reload, and they're still done.
const cuts = page.locator('#sawOut .cut[data-k]');
for (let i = 0; i < 3; i++) await cuts.nth(i).click();
assert.equal(await page.textContent('.saw-bar b'), '3 of 27 cuts');
await page.waitForTimeout(600);
await page.reload();
await page.waitForSelector('#sawOut .cut[data-k]');
assert.equal(await page.textContent('.saw-bar b'), '3 of 27 cuts', 'ticks survive a reload');
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

// The saw counts the cuts the plan counts: a part that comes off with no cut is a note, not a cut to tick. The
// example's tip makes each pair of rails fill an 8' board, so the second rail is what's left.
{
  const sawTotal = async () => +(await page.textContent('.saw-bar b')).match(/of (\d+)/)[1];
  await open(null);
  assert.equal(await sawTotal(), parseInt(await cutsFact()), 'the saw counts more cuts than the plan');
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  await page.click('[data-tip]');
  await page.waitForTimeout(600);
  assert.equal(parseInt(await cutsFact()), 23);
  assert.equal(await sawTotal(), 23, 'after the tip, the saw counts more cuts than the plan');
  assert.ok((await page.textContent('#sawOut')).includes('What’s left is B Front & back rail — no cut needed'), 'no note for a rail that needs no cut');
  // It reads as a line of text: the letter sits a space after "is", not spread out like the parts of a cut's row.
  await view('saw');
  assert.ok(await page.$eval('#sawOut .cut.note b', b => { const r = document.createRange(); r.selectNodeContents(b.previousSibling); return b.getBoundingClientRect().left - r.getBoundingClientRect().right < 6; }), 'the no-cut note is spread out');
}

// Ticks stay on the cut they were made on. Each material keeps its own, keyed to what its cuts are, so an edit to
// another material leaves them be, and a change that comes back (a count changed and changed back) brings them back.
// When a material's plan does change, its ticks clear and a toast says so; none ever lands on a different cut.
{
  const tickedRows = () => page.$$eval('#sawOut .cut[data-k]', els => els.filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.dataset.k));
  const toastNow = () => page.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.firstChild.textContent : ''; });
  const part = (mat, i, f) => page.locator(`#mats .mat >> nth=${mat}`).locator(`.prow[data-pid] input[data-f="${f}"] >> nth=${i}`);
  const settle = () => page.waitForTimeout(600);
  await open(null);
  await view('saw');
  for (let i = 0; i < 4; i++) await cuts.nth(i).click();
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
  assert.equal(await page.textContent('.saw-bar b'), '2 of 27 cuts');
  await page.click('#setBtn');
  await page.fill('#sTrim', '1/4');
  await page.click('#stx');
  await settle();
  assert.equal(await toastNow(), 'The 2×4 plan changed, so its 2 ticked cuts were cleared');
  assert.deepEqual(await tickedRows(), [], 'a tick moved onto another cut when trim was turned on');
  assert.match(await page.textContent('#sawOut .cut[data-k] .what'), /^Square up one end/);
  assert.match(await page.textContent('.saw-bar b'), /^0 of /);

  // A sheet part resized where it sits: the full sheet's crosscut moves from 30" to 40", so its tick clears.
  await open(saved(project('One shelf', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }], [{ name: 'Shelf', qty: 1, len: 30, wid: 20 }])])));
  await view('saw');
  assert.match(await page.textContent('#sawOut .cut[data-k] .what'), /^Crosscut the full sheet/);
  assert.equal(await page.textContent('#sawOut .cut[data-k] .meas'), '30″');
  await cuts.nth(0).click();
  await view('list');
  await part(0, 0, 'len').fill('40');
  await settle();
  assert.equal(await toastNow(), 'The ¾ plywood plan changed, so its ticked cut was cleared');
  await view('saw');
  assert.equal(await page.textContent('#sawOut .cut[data-k] .meas'), '40″');
  assert.deepEqual(await tickedRows(), [], 'the tick on the 30" crosscut moved to the 40" one');
}

// A part's ✕ removes it at once, and Undo puts it back: the same plan, and the same ticks at the saw. Start over can
// be undone too.
{
  const tickedRows = () => page.$$eval('#sawOut .cut[data-k]', els => els.filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.dataset.k));
  const plan = () => page.evaluate(() => [...document.getElementById('planOut').children].filter(c => c.id !== 'tips').map(c => c.outerHTML).join('') + document.getElementById('sawOut').innerHTML);
  await open(null);
  await view('saw');
  for (const i of [0, 1, 2, 5]) await cuts.nth(i).click();
  const before = await plan(), ticks = await tickedRows();
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
assert.deepEqual(Object.values((await stored()).projects).map(p => p.name).sort(), ['Garage shelves (example)', 'Mudroom bench']);

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
assert.equal((await stored()).order.length, 3);

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
  assert.equal(await count(), 2);
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
  assert.equal(await count(), 2, 'opening the same plan again added a copy');
  // Duplicate this one makes a copy that didn't come from the link: opening the link again opens the original.
  await page.click('#projBtn');
  await page.click('#pjDup');
  assert.equal(await page.inputValue('#pname'), 'Mudroom bench copy');
  await page.evaluate(hash => { location.hash = hash; }, linkTo(MUDROOM));
  await again('Open a project from a link');
  // Add another copy still adds one.
  await page.click('#projBtn');
  await pasteIn(JSON.stringify(MUDROOM));
  await page.waitForSelector('#lkOpen');
  await page.click('#lkAdd');
  assert.equal(await count(), 4);
  // Updated today: the time, so two copies of one name can be told apart; on another day, the date.
  const db = await stored();
  await open({ ...db, projects: { ...db.projects, [db.order[3]]: { ...db.projects[db.order[3]], updated: Date.now() - 3 * 86400000 } } });
  await page.click('#projBtn');
  const rows = await page.$$eval('#pjList .pitem span', s => s.map(x => x.textContent));
  assert.ok(rows.slice(0, 3).every(r => / · \d{1,2}:\d\d/.test(r)), 'a project changed today shows its date, not the time: ' + rows.join(', '));
  assert.ok(!/:/.test(rows[3]), 'a project changed days ago shows a time: ' + rows[3]);
  await page.click('#pjx');
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
  ], { units: 'mm', kerf: 0.09375, trim: 0.5, keep: 18, cur: '€' });
  big.materials[1].note = 'A1 grade';
  await open(saved(big));
  await page.click('#projBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pjExport')]);
  await page.setInputFiles('#pjFile', await dl.path());
  await page.waitForSelector('#lkAdd');
  assert.deepEqual(await page.$$eval('#sheet .note', ns => ns.map(n => n.textContent)), ['It comes in as a new project; nothing you already have changes. Check the prices — they’re whatever the file came with.'], 'a project Kerf saved doesn’t open whole');
  await page.click('#lkAdd');
  const back = await stored();
  assert.equal(back.order.length, 2);
  assert.deepEqual(bare(back.projects[back.order[0]]), bare(big), 'a project saved as a file comes back different');

  const many = Array.from({ length: 1005 }, (_, i) => ({ name: 'Slat ' + i, qty: 0, len: 20 }));
  many[3] = { name: 'A long name '.repeat(21), qty: 2, len: 30 }; // 252 characters
  await page.click('#projBtn');
  await pasteIn(JSON.stringify({ kerf: 1, project: { name: 'Over the limits', materials: [
    { kind: 'board', name: '2×4', parts: many },
    { kind: 'sheet', name: 'Ply', stock: Array.from({ length: 52 }, () => ({ len: 96, wid: 48, price: 58 })), parts: [{ name: 'Side', len: 30, wid: 12 }, { name: 'Back', qty: null, len: 30, wid: 20, grain: false }, { name: 'Spare', qty: 0, len: 10, wid: 10 }, { name: 'Top', qty: '', len: 30, wid: 20 }] },
  ] } }));
  await page.waitForSelector('#lkAdd', { timeout: 5000 });
  assert.equal(await page.textContent('#sheet h2'), 'Open pasted project');
  assert.deepEqual((await page.$$eval('#sheet .note', ns => ns.map(n => n.textContent))).slice(0, 4), [
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

// Opening Kerf writes nothing until something really changes. A first visit that only looks around leaves
// storage empty, so carry.js can still bring projects over from junkdrawer.works/kerf/ on a later visit.
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
  assert.deepEqual(await small('#mats input, #mats select'), [], 'fields in the cut list under 16px');
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

// Face-frame stock is a preset, and a material not on the list ('Other board') is named first: its name is selected.
await open(saved(project('Bookcase', [])));
await view('list');
await page.click('.pbtn >> text=1×2 board');
assert.equal(await page.textContent('.mat .mat-note'), '¾ × 1½ in');
assert.match(await page.textContent('details.stock .chips'), /6′ · \$2\.38.*8′ · \$2\.98/);
await page.click('.pbtn >> text=Other board');
await page.keyboard.type('Poplar 1×5');
assert.deepEqual(await page.$$eval('#mats .mat-name', is => is.map(i => i.value)), ['1×2 board', 'Poplar 1×5'], 'Other board doesn’t start on its name');

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
  assert.deepEqual(await page.$$eval('.mat:not(.sheetmat) .prow[data-pid]', rs => rs.map(r => [...r.querySelectorAll('input')].map(i => i.value).join('|'))), ['Leg|4|30"', 'Apron|2|20"', '|1|']);
  // A blank part's length (and a sheet part's width) shows an example of how to type it.
  assert.deepEqual(await page.$$eval('.prow[data-pid] input', is => [...new Set(is.map(i => i.dataset.f + ':' + i.placeholder))]), ['pname:Part', 'qty:', 'len:35 3/4', 'wid:16'], 'a length field’s example is broken');
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

// "Have 1" on a size you buy means you own one: Kerf uses it and still buys that size. Six 72" sides need two 4×8
// sheets, and with one on hand the plan buys the other, where it used to drop the plywood from the plan.
{
  await open(saved(project('On hand', [sheet('¾ plywood', [{ len: 96, wid: 48, price: 58 }, { len: 48, wid: 48, price: 34 }, { len: 48, wid: 24, price: 21 }], [{ name: 'Side', qty: 6, len: 72, wid: 11.25 }])])));
  assert.equal(await page.textContent('.total'), '$116.00');
  await view('list');
  await page.click('details.stock summary');
  await page.selectOption('.srow[data-sid] select >> nth=0', '1');
  assert.equal(await page.textContent('#toast'), 'Kerf will use your 1 and buy more 4′ × 8′ if it needs them');
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
  // Without a 4×8 to buy, the cut list says only the sheet you have could hold the sides.
  await view('list');
  await page.click('.srow[data-sid] >> nth=1 >> [data-a="delstock"]');
  await page.waitForFunction(() => !document.querySelector('.perr').hidden, null, { timeout: 5000 });
  assert.equal(await page.textContent('.perr'), 'The sheets you have can’t hold every part, and Side (72" × 11 1/4") fits only those. Add a size to buy that fits it.');
}

// A price is kept to the cent, so the shopping list's lines add up to its total: 3 × $4.285 and 3 × $5.485 used to
// show as $12.86 and $16.46 over a total of $29.31.
{
  await open(saved(project('Cents', [board('2×4', [{ len: 96, price: 4 }], [{ name: 'Leg', qty: 3, len: 90 }]), board('1×4 board', [{ len: 96, price: 5 }], [{ name: 'Slat', qty: 3, len: 90 }])])));
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

// A board you already have is labelled "yours" inside its drawing, not cut off past the edge.
await open(saved(project('Yours', [board('2×4', [{ len: 96, price: 4.28 }, { len: 96, have: 1 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
assert.ok(await page.evaluate(() => {
  const svg = document.querySelector('#planOut svg.diag'), yours = [...svg.querySelectorAll('text')].find(t => t.textContent === 'yours');
  return yours.getBoundingClientRect().right <= svg.getBoundingClientRect().right + 0.5;
}), '"yours" runs past the drawing');

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

// On a phone the top bar's buttons show only their icons, but each still has a name.
for (const name of ['Projects', 'Shop PDF', 'Settings']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `no button named ${name} on a phone`);

// Ticking a cut from the keyboard keeps focus on that cut, and Start over moves it to the first one.
await view('saw');
await page.locator('#sawOut .cut[data-k]').nth(1).focus();
await page.keyboard.press('Space');
assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.k.split('/')[1], document.activeElement.getAttribute('aria-checked')]), ['0.1', 'true'], 'focus left the cut just ticked');
await page.focus('#sawReset');
await page.keyboard.press('Enter');
assert.equal(await page.evaluate(() => document.activeElement.dataset.k.split('/')[1]), '0.0', 'focus after Start over');
assert.match(await page.textContent('.saw-bar b'), /^0 of /);

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
    return page.evaluate(() => window.tipsAfter);
  };
  await open(null);
  await page.waitForSelector('[data-tip]', { timeout: 30000 });
  assert.ok((await page.textContent('#tips')).includes(RAIL_TIP));
  const applied = await tipsAfterTap(() => page.click('[data-tip]'));
  assert.equal(await page.inputValue('.prow[data-pid] >> nth=1 >> [data-f="len"]'), '47 15/16"');
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
  assert.equal(await page.textContent('[data-tip]'), 'Use 47 15/16"');
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
    assert.match(await cp.textContent('.sheetmat .perr'), /^Bench top \(100" × 30"\) won’t fit/, 'the cut list has the old name');
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
  assert.equal(await page.textContent('#toast'), 'Deleted “Keep me”');
}

// In mm a length in a field is the bare number, with the number pad: "1233.5", not "1233.5 mm" cut short on a phone.
{
  await open(saved(project('Metrisch', [board('45×90', [{ len: 2400 / 25.4, price: 6.5 }], [{ name: 'Bein', qty: 2, len: 1233.5 / 25.4 }]),
    sheet('18 mm plywood', [{ len: 2440 / 25.4, wid: 1220 / 25.4, price: 62 }], [{ name: 'Seite', qty: 1, len: 2033.5 / 25.4, wid: 1210 / 25.4 }])], { units: 'mm' })));
  await view('list');
  const fields = () => page.$$eval('#mats input.mono:not([data-f="qty"]):not([data-f="price"])', is => is.map(i => i.dataset.f + ' ' + i.value + ' ' + i.inputMode));
  assert.deepEqual(await fields(), ['len 1233.5 decimal', 'slen 2400 decimal', 'len 2033.5 decimal', 'wid 1210 decimal', 'slen 2440 decimal', 'swid 1220 decimal']);
  assert.deepEqual(await page.$$eval('.prow[data-pid] input[data-f="len"], .prow[data-pid] input[data-f="wid"]', is => is.map(i => i.placeholder)), ['900', '900', '400'], 'an mm length field’s example is broken');
  const len = page.locator('.prow[data-pid] input[data-f="len"]').first();
  await len.fill('1250');
  await len.blur();
  assert.equal(await len.inputValue(), '1250');
  await page.waitForTimeout(600);
  await view('plan');
  assert.match(await page.textContent('#planOut .steps'), /Bein · 2 × 1250 mm/, 'a bare number isn’t read as mm');
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
assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¾ plywood: the sheets you have can’t hold every part; 4×4 has 1 part too big for any size listed — see the cut list.');

// Kerf plans at most 300 of one sheet part: past that, the plan says parts are left out and the cut list says why.
await open(saved(project('Pegboard', [sheet('¼ plywood', [{ len: 96, wid: 48, price: 28 }], [{ name: 'Peg', qty: 400, len: 4, wid: 4, grain: false }])])));
assert.equal(await page.textContent('#planOut .warn'), 'Some parts are left out. ¼ plywood has 1 part with more than 300 pieces — see the cut list.');
await view('list');
assert.equal(await page.textContent('.perr'), 'Peg × 400: Kerf plans at most 300 of one sheet part — split it into two rows.');

// An empty plan points to the cut list (a phone has no left side), and when every part is left out it says why.
await open(saved(project('Nothing yet', [])));
assert.match(await page.textContent('#planOut .empty'), /^Nothing to cut yet\.Add a material in the cut list, then the parts you need from it/);
await open(saved(project('Too long', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Beam', qty: 1, len: 120 }])])));
assert.equal(await page.textContent('#planOut'), 'Some parts are left out. 2×4 has 1 part too big for any size listed — see the cut list.');
await open(saved(project('Short of legs', [board('Other board', [{ len: 96, have: 2 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
assert.equal(await page.textContent('#planOut'), 'Some parts are left out. Other board: the boards you have can’t hold every part — see the cut list.');

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

// An offcut's label fits inside the offcut: on a phone "keep 23 7/8\"" is too wide for it, so it shows the length alone.
await open(saved(project('Offcut', [board('2×4', [{ len: 96, price: 4.28 }], [{ name: 'Leg', qty: 1, len: 72 }])])));
assert.deepEqual(await page.$$eval('#planOut .dg-scrapt', ts => ts.map(t => [t.textContent, t.getBBox().width <= t.previousElementSibling.width.baseVal.value - 2])), [['23 7/8"', true]], 'the offcut label');

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

// Kerf plans up to 500 of a part: a bigger quantity is marked, and becomes 500 when you leave the field.
await open(saved(project('Pegs', [board('1×2', [{ len: 96, price: 2.98 }], [{ name: 'Peg', qty: 2, len: 3 }])])));
await view('list');
{
  const qty = page.locator('.prow[data-pid] input[data-f="qty"]');
  await qty.fill('600');
  assert.ok(await qty.evaluate(e => e.classList.contains('bad')), '600 isn\'t marked');
  await qty.blur();
  assert.deepEqual([await qty.inputValue(), await qty.evaluate(e => e.classList.contains('bad'))], ['500', false]);
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
const RAIL = 'Measure from the end, cut on the waste side of the mark', FRESH = 'Measure from the fresh end';
const sawCases = [
  { trim: 0, parts: [{ name: 'Rail', qty: 2, len: 47.875 }], steps: [RAIL, FRESH], cuts: 2, lines: 2 },
  { trim: 0.25, parts: [{ name: 'Rail', qty: 2, len: 47 + 11 / 16 }], steps: ['Trim off 1/4" and measure every part from this fresh end', RAIL, FRESH + ' — this cut squares up the far end too'], cuts: 3, lines: 2 },
  { trim: 0.25, parts: [{ name: 'Top', qty: 1, len: 95.5 }], steps: ['Trim off 1/4" and measure every part from this fresh end', RAIL + ' — this cut squares up the far end too'], cuts: 2, lines: 1 },
  { trim: 0, parts: [{ name: 'Top', qty: 1, len: 96 }], steps: [], note: 'What’s left is A Top — no cut needed', cuts: 0, lines: 0 },
  { trim: 0, parts: [{ name: 'Leg', qty: 1, len: 72 }], steps: [RAIL], cuts: 1, lines: 1 },
];
for (const c of sawCases) {
  await open(saved(project('Saw', [board('2×4', [{ len: 96, price: 4.28 }], c.parts)], { trim: c.trim })));
  const what = `${c.parts[0].qty} × ${c.parts[0].len} on 8', trim ${c.trim}`;
  assert.equal(await cutsFact(), c.cuts + (c.cuts === 1 ? 'cut' : 'cuts'), what + ': cuts in the plan');
  assert.equal(await page.locator('#planOut .dg-kerf').count(), c.lines, what + ': saw cuts drawn');
  assert.equal(pdfKerfLines(await shopPdf()), c.lines, what + ': saw cuts in the PDF');
  await view('saw');
  assert.deepEqual(await sawSteps(), c.steps, what + ': steps at the saw');
  assert.equal(await page.textContent('.saw-bar b'), `0 of ${c.cuts} ${c.cuts === 1 ? 'cut' : 'cuts'}`, what + ': cuts at the saw');
  if (c.note) assert.equal(await page.textContent('#sawOut .cut.note'), c.note, what + ': the note at the saw');
}

// Boards on hand that run short say so in the cut list, instead of stopping the page.
await open(saved(project('Short of legs', [board('Other board', [{ len: 96, have: 2 }], [{ name: 'Leg', qty: 3, len: 72 }])])));
await view('list');
assert.equal(await page.textContent('.perr'), 'The boards you have can’t hold every part, and Leg (72") fits only those. Add a size to buy that fits it.');

assert.deepEqual(problems, [], 'no errors, and nothing loaded from anywhere else');

// Works offline once it has been opened, fonts and all.
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('#planOut > *', { state: 'attached' });
assert.equal(await page.inputValue('#pname'), 'Short of legs', 'the page did not load offline');
assert.deepEqual(await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'error').map(f => f.family); }), [], 'a font failed offline');
await ctx.setOffline(false);

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while offline');
await browser.close();
server.close();
console.log('kerf e2e: all passed');
