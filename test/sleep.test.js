// Sleeping tabs and background speed: the user's tabs that have been out of
// sight for a while are unloaded to free memory and load again when opened;
// the user's background tabs are throttled; Claude's tabs never sleep and run
// at full speed. The profile sets a 6-second limit instead of 15 minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-test-'));
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sleepAfterMinutes: 0.1 }));
let b;
test.before(async () => { b = await launch({}, { home }); });
test.after(async () => {
  await b?.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} // helper processes may still be closing files
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const tab = async (id) => (await b.state()).tabs.find((t) => t.id === id);
const onScreen = async () => (await b.state()).tabs.find((t) => t.active);
async function until(what, ok, ms = 15000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await pause(200)) {
    last = await what();
    if (ok(last)) return last;
  }
  assert.fail(`gave up waiting; last saw ${JSON.stringify(last)}`);
}
const loaded = (id) => until(() => tab(id), (t) => t && !t.loading && t.url);
// Opens a page in a new tab of the user's, on screen, once it has loaded.
async function open(url) {
  await b.ui('tab:new', url);
  return loaded((await onScreen()).id);
}
// How many times a 10 ms timer fires in a page in 2 seconds.
const TICKS = 'new Promise((r) => { let n = 0; const i = setInterval(() => n++, 10); setTimeout(() => { clearInterval(i); r(n); }, 2000); })';

test('a tab the user has not looked at for a while falls asleep, keeping its title, address and history', async () => {
  const first = await onScreen();
  await b.ui('go', b.base);
  await until(() => tab(first.id), (t) => t.url === b.base + '/' && !t.loading);
  await b.ui('go', b.base + '/second.html');
  await until(() => tab(first.id), (t) => t.title === 'Second' && !t.loading);
  await open(b.base + '/index.html?other');
  const asleep = await until(() => tab(first.id), (t) => t.asleep);
  assert.equal(asleep.title, 'Second');
  assert.equal(asleep.url, b.base + '/second.html');
  assert.ok(asleep.canGoBack, 'back still works from the tab strip');
  assert.ok(!(await onScreen()).asleep, 'the tab on screen stays awake');
});

test('opening a sleeping tab loads it again, with its history', async () => {
  const sleeping = (await b.state()).tabs.find((t) => t.asleep);
  await b.ui('tab:select', sleeping.id);
  const back = await loaded(sleeping.id);
  assert.equal(back.asleep, false);
  assert.equal(back.url, b.base + '/second.html');
  assert.equal(await b.ui('tab:js', { id: sleeping.id, code: 'document.querySelector("h1").textContent' }), 'Second page');
  await b.ui('back');
  await until(() => tab(sleeping.id), (t) => t.url === b.base + '/' && !t.loading);
});

test('"Sleep this tab now" puts a background tab to sleep at once, but never the tab on screen', async () => {
  const shown = await onScreen();
  const other = await open(b.base + '/second.html?now');
  assert.equal(await b.ui('tab:sleep', other.id), false, 'the tab on screen cannot sleep');
  await b.ui('tab:select', shown.id);
  assert.equal(await b.ui('tab:sleep', other.id), true);
  assert.ok((await tab(other.id)).asleep);
});

test('a page woken from sleep comes back scrolled to where the user left it', async () => {
  const shown = await onScreen();
  const long = await open(b.base + '/index.html?scrolled');
  await b.ui('tab:js', { id: long.id, code: 'window.scrollTo(0, 900); scrollY' });
  await pause(1500); // Chromium records the scroll position with the page's history a moment later
  await b.ui('tab:select', shown.id);
  assert.equal(await b.ui('tab:sleep', long.id), true);
  await b.ui('tab:select', long.id);
  await loaded(long.id);
  const y = await until(() => b.ui('tab:js', { id: long.id, code: 'scrollY' }), (v) => v > 0, 5000);
  assert.ok(Math.abs(y - 900) < 50, `scrolled to ${y}`);
});

test('a tab with form input the user has not sent stays awake', async () => {
  const form = await open(b.base + '/index.html?form');
  await b.ui('tab:js', { id: form.id, code: 'document.querySelector("[name=who]").value = "half-typed"' });
  const clean = await open(b.base + '/index.html?clean');
  await b.ui('tab:select', (await b.state()).tabs.find((t) => t.group === 'you' && t.id !== form.id && t.id !== clean.id && !t.asleep).id);
  await until(() => tab(clean.id), (t) => t.asleep);
  assert.equal((await tab(form.id)).asleep, false, 'the half-filled form is still there');
  assert.equal(await b.ui('tab:js', { id: form.id, code: 'document.querySelector("[name=who]").value' }), 'half-typed');
});

test('Claude\'s tabs never sleep, and Claude can still click, type and capture in them', async () => {
  const a = b.as('a', 'Claude Code');
  await a.text('navigate', { url: b.base });
  await pause(9000); // past the limit
  const mine = (await b.state()).tabs.filter((t) => t.group === 'a');
  assert.ok(mine.length && mine.every((t) => !t.asleep));
  const field = (await a.text('snapshot')).match(/textbox "Your name" \[(e\d+)\]/)[1];
  assert.match(await a.text('type', { ref: field, text: 'Ada', clear: true, submit: true }), /text "Hello, Ada \(s\)"/);
  const count = (await a.text('snapshot')).match(/button "Count" \[(e\d+)\]/)[1];
  assert.match(await a.text('click', { ref: count }), /button "Clicked 1"/);
  const [note, image] = await a.call('screenshot');
  assert.match(note.text, /^Visible page/);
  assert.ok(image.data.length > 5000, 'a real picture, not a blank one');
});

test('the user\'s background tabs are throttled; Claude\'s run at full speed', async () => {
  const a = b.as('a');
  const shown = await onScreen();
  const back = await open(b.base + '/index.html?throttled');
  await b.ui('tab:select', shown.id);
  const [user, claude] = await Promise.all([
    b.ui('tab:js', { id: back.id, code: TICKS }),
    a.text('evaluate', { code: TICKS }).then(Number),
  ]);
  assert.ok(claude > 100, `Claude's background tab ran its timer ${claude} times`);
  assert.ok(user < claude / 3, `the user's background tab ran its timer ${user} times (Claude's: ${claude})`);
  a.end();
});

test('sleeping frees memory: six tabs, before and after', async (t) => {
  for (const x of (await b.state()).tabs.filter((x) => x.group === 'you')) if (!x.active) await b.ui('tab:close', x.id);
  const opened = [];
  for (let i = 0; i < 6; i++) opened.push(await open(`${b.base}/index.html?memory${i}`));
  await pause(1500);
  const before = await b.ui('memory');
  for (const x of opened.slice(0, 5)) await b.ui('tab:sleep', x.id);
  await pause(3000); // renderer processes take a moment to exit
  const after = await b.ui('memory');
  const mb = (kb) => (kb / 1024).toFixed(0);
  t.diagnostic(`6 tabs awake: ${mb(before.kb)} MB in ${before.processes} processes; ` +
    `5 of them asleep: ${mb(after.kb)} MB in ${after.processes} processes`);
  assert.ok(after.kb < before.kb, 'less memory in use');
  assert.ok(after.processes < before.processes, 'fewer processes');
});

test('after a restart, only the tab on screen loads; the others start asleep', async () => {
  const before = (await b.state()).tabs.filter((t) => t.group === 'you');
  await b.close();
  fs.rmSync(path.join(home, 'loui.sock'), { force: true }); // else launch may find the old one
  b = await launch({}, { home });
  const tabs = await until(async () => (await b.state()).tabs, (list) => list.length === before.length);
  const shown = tabs.find((t) => t.active);
  assert.equal(shown.asleep, false);
  assert.ok(tabs.filter((t) => t !== shown).every((t) => t.asleep), 'the others are asleep');
  assert.deepEqual(tabs.map((t) => t.url), before.map((t) => t.url), 'every tab keeps its address');
  const other = tabs.find((t) => t !== shown);
  await b.ui('tab:select', other.id);
  assert.equal((await loaded(other.id)).asleep, false);
});

test('a page brought back from sleep does not start playing by itself; pressing play in it works', async () => {
  const shown = await onScreen();
  const media = await open(b.base + '/media.html');
  const paused = () => b.ui('tab:js', { id: media.id, code: 'document.getElementById("a").paused' });
  await until(paused, (p) => p === false); // opened by the user: it plays, as always
  await b.ui('tab:js', { id: media.id, code: 'document.getElementById("a").pause(); 1' }); // (a tab that is playing is not put to sleep)
  await b.ui('tab:select', shown.id);
  assert.equal(await b.ui('tab:sleep', media.id), true);
  await b.ui('tab:select', media.id);
  await loaded(media.id);
  await pause(1200); // it would have started by now
  assert.equal(await paused(), true, 'held until the user does something in the page');
  // The user's own press on its play button.
  const at = JSON.parse(await b.ui('tab:js', { id: media.id, code: 'JSON.stringify(document.getElementById("play").getBoundingClientRect())' }));
  await b.ui('tab:press', { id: media.id, x: Math.round(at.x + at.width / 2), y: Math.round(at.y + at.height / 2) });
  await until(paused, (p) => p === false);
});

test('a play button on a page brought back starts its player in a frame from another site', async () => {
  const shown = await onScreen();
  const outer = await open(b.base + '/media-outer.html');
  const inner = (code) => b.ui('frame:js', { id: outer.id, match: 'media-inner', code });
  await until(() => inner('!!document.getElementById("a")'), (ok) => ok === true);
  await b.ui('tab:select', shown.id);
  assert.equal(await b.ui('tab:sleep', outer.id), true);
  await b.ui('tab:select', outer.id);
  await loaded(outer.id);
  await until(() => inner('window.__louiQuiet'), (q) => q === 'on'); // the frame is being held
  // The user's press on the page's own button: the frame is told to play, and does.
  const at = JSON.parse(await b.ui('tab:js', { id: outer.id, code: 'JSON.stringify(document.getElementById("play").getBoundingClientRect())' }));
  await b.ui('tab:press', { id: outer.id, x: Math.round(at.x + at.width / 2), y: Math.round(at.y + at.height / 2) });
  await until(() => inner('document.getElementById("a").paused'), (p) => p === false);
});
