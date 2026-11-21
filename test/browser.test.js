// End-to-end: launches the real app on a throwaway profile and drives it over
// the control socket, the same way Claude Code does. Needs a display; `npm test`
// supplies a virtual one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
// The ref of the element whose outline line starts with this, e.g. 'button "Greet"'.
const ref = (outline, start) => {
  const line = outline.split('\n').find((l) => l.trim().startsWith(start));
  assert.ok(line, `no "${start}" in:\n${outline}`);
  return line.match(/\[(e\d+)\]/)[1];
};
const home = () => b.text('navigate', { url: b.base });

test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

test('navigate returns an outline with refs', async () => {
  const page = await home();
  assert.match(page, /^Opened http/);
  assert.match(page, /heading1 "Fixture page"/);
  assert.match(page, /navigation "Primary" \[e\d+\]/);
  assert.match(page, /link "Second page" \[e\d+\] -> \/second\.html/);
  assert.match(page, /text "Some plain text with inline bits\."/);
  assert.match(page, /clickable "A clickable card"/);
});

test('form controls are named by their labels, once', async () => {
  const page = await home();
  assert.match(page, /textbox "Your name" \[e\d+\] value="old"/);
  assert.match(page, /select "Size" \[e\d+\] value="Small" options=\["Small","Large"\]/);
  assert.match(page, /checkbox "Agree"/);
  assert.doesNotMatch(page, /text "Your name"/);
});

test('refs stay the same between snapshots', async () => {
  const first = await home();
  const again = await b.text('snapshot');
  assert.equal(ref(again, 'button "Greet"'), ref(first, 'button "Greet"'));
});

test('type, choose and click fill in and submit a form', async () => {
  const page = await home();
  await b.text('type', { ref: ref(page, 'textbox "Your name"'), text: 'Ada', clear: true });
  await b.text('select_option', { ref: ref(page, 'select "Size"'), value: 'Large' });
  const after = await b.text('click', { ref: ref(page, 'button "Greet"') });
  assert.match(after, /^Clicked button "Greet"/);
  assert.match(after, /text "Hello, Ada \(l\)"/);
});

test('type appends by default and can submit with Enter', async () => {
  const page = await home();
  const after = await b.text('type', { ref: ref(page, 'textbox "Your name"'), text: 'er', submit: true });
  assert.match(after, /text "Hello, older \(s\)"/);
});

test('press_key reaches the focused field', async () => {
  const page = await home();
  await b.text('type', { ref: ref(page, 'textbox "Your name"'), text: 'Grace', clear: true });
  const after = await b.text('press_key', { key: 'Enter' });
  assert.match(after, /text "Hello, Grace \(s\)"/);
});

test('click, double click, and checkboxes', async () => {
  const page = await home();
  const count = ref(page, 'button "Count"');
  assert.match(await b.text('click', { ref: count }), /button "Clicked 1"/);
  assert.match(await b.text('click', { ref: count, double: true }), /button "Clicked 3"/);
  assert.match(await b.text('click', { ref: ref(page, 'checkbox "Agree"') }), /checkbox "Agree" \[e\d+\] \(checked\)/);
});

test('wait_for sees text that arrives later', async () => {
  const page = await home();
  await b.text('click', { ref: ref(page, 'button "Later"') });
  assert.match(await b.text('wait_for', { text: 'Late arrival' }), /text "Late arrival"/);
  await assert.rejects(b.text('wait_for', { text: 'never shown', seconds: 0.5 }), /has not appeared/);
});

test('scroll moves the page', async () => {
  await home();
  assert.match(await b.text('scroll', { direction: 'bottom' }), /^Scrolled to [1-9]\d* of/);
  assert.match(await b.text('scroll', { direction: 'top' }), /^Scrolled to 0 of/);
});

test('console and network history', async () => {
  const page = await home();
  await b.text('click', { ref: ref(page, 'button "Break"') });
  await b.text('wait_for', { seconds: 0.5 });
  assert.match(await b.text('console_logs', { level: 'error' }), /\[error\] kaboom from fixture/);
  const failed = await b.text('network_requests', { failed_only: true });
  assert.match(failed, /404 {2}GET {2}\w+ .*\/missing\.json/);
  assert.match(await b.text('network_requests', { contains: '127.0.0.1' }), /200 {2}GET {2}mainFrame/);
});

test('evaluate takes an expression or a function body', async () => {
  await home();
  assert.equal(await b.text('evaluate', { code: 'document.title' }), '"Fixture"');
  assert.equal(await b.text('evaluate', { code: 'const n = 2; return n * 21;' }), '42');
  assert.match(await b.text('evaluate', { code: '({ a: [1, 2] })' }), /"a"/);
});

test('screenshots: viewport, one element, whole page', async () => {
  const page = await home();
  const [note, image] = await b.call('screenshot');
  assert.match(note.text, /^Visible page, \d+x\d+/);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.ok(image.data.length > 5000);
  const [, one] = await b.call('screenshot', { ref: ref(page, 'button "Greet"') });
  assert.ok(one.data.length > 300 && one.data.length < image.data.length);
  const [whole] = await b.call('screenshot', { full_page: true });
  assert.match(whole.text, /^Whole page/);
});

test('click by screenshot coordinates', async () => {
  await home();
  await b.call('screenshot');
  const at = JSON.parse(await b.text('evaluate', {
    code: '(() => { const r = document.getElementById("count").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()',
  }));
  assert.match(await b.text('click', { x: at[0], y: at[1] }), /button "Clicked 1"/);
});

test('links that open a new tab, tab listing, history', async () => {
  const page = await home();
  const opened = await b.text('click', { ref: ref(page, 'link "New tab link"') });
  assert.match(opened, /opened a new tab/);
  assert.match(opened, /heading1 "Second page"/);
  const list = await b.text('tabs', { action: 'list' });
  const [, id] = list.match(/> (\d+) {2}Second/);
  assert.match(await b.text('tabs', { action: 'close', id: +id }), /> \d+ {2}Fixture/);

  await b.text('click', { ref: ref(page, 'link "Second page"') });
  assert.match(await b.text('history', { action: 'back' }), /heading1 "Fixture page"/);
});

test('a ref from a page that is gone says so', async () => {
  const page = await home();
  const greet = ref(page, 'button "Greet"');
  await b.text('navigate', { url: b.base + '/second.html' });
  await assert.rejects(b.text('click', { ref: greet }), /no longer on the page/);
});

test('device emulation changes the viewport, and clicks still land', async () => {
  const page = await home();
  assert.match(await b.text('set_viewport', { preset: 'ipad' }), /820x1180/); // scaled down to fit
  assert.match(await b.text('set_viewport', { preset: 'iphone' }), /393x852/);
  const narrow = await b.text('snapshot');
  assert.match(await b.text('click', { ref: ref(narrow, 'button "Count"') }), /button "Clicked 1"/);
  assert.doesNotMatch(await b.text('set_viewport', { preset: 'desktop' }), /393x/);
  assert.ok(page);
});

test('only web pages can be opened', async () => {
  await assert.rejects(b.text('navigate', { url: 'file:///etc/passwd' }), /Only http and https/);
});

test('the user can point at an element', async () => {
  await home();
  assert.match(await b.text('picks'), /has not pointed at anything/);
  const asked = b.call('ask_user_to_pick', { message: 'Which button?' });
  await new Promise((r) => setTimeout(r, 400));
  const at = JSON.parse(await b.text('evaluate', {
    code: '(() => { const r = document.getElementById("card").getBoundingClientRect(); return [r.x + 20, r.y + 10]; })()',
  }));
  // Stands in for the user's click. The page must not see it while pointing is on.
  await b.call('click', { x: at[0], y: at[1] });
  const [described, image] = await asked;
  assert.match(described.text, /selector: #card/);
  assert.match(described.text, /text: A clickable card/);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.match(await b.text('picks'), /selector: #card/);
});

test('the address bar follows the page again after a click in the page', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = (await b.state()).tabs.find((t) => t.active);
  await b.ui('tab:js', { id: tab.id, code: `location.href = ${JSON.stringify(b.base + '/plain.html')}; 1` });
  await b.ui('chrome:eval', "document.getElementById('address').focus(); 1"); // as a new tab leaves it
  await b.ui('tab:press', { id: tab.id, x: 300, y: 300 }); // the user clicks in the page: the field stays the chrome's active element
  await b.ui('tab:js', { id: tab.id, code: `location.href = ${JSON.stringify(b.base + '/second.html?followed')}; 1` });
  let shown;
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
    shown = await b.ui('chrome:eval', "document.getElementById('address').value");
    if (shown.endsWith('/second.html?followed')) break;
  }
  assert.match(shown, /second\.html\?followed$/);
});

test("Loui's own window can't be turned into a web page", async () => {
  // Stands in for dropping a link on the toolbar: anything that tries to
  // navigate the window chrome is stopped, and the chrome stays Loui's.
  const before = (await b.state()).tabs.length;
  const url = await b.ui('chrome-navigate', b.base + '/second.html');
  assert.match(url, /^file:.*index\.html$/);
  const state = await b.state();
  assert.equal(state.tabs.length, before, 'the chrome still answers, with the same tabs');
});

test('with nothing open, the page sits right under the toolbar', async () => {
  // No find bar, downloads list, permission question or bookmarks bar is
  // showing, so nothing should take room between the toolbar and the page.
  const gap = await b.ui('chrome:eval', `(() => {
    const nav = document.getElementById('navrow').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return Math.round(stage.top - nav.bottom);
  })()`);
  assert.equal(gap, 0);
});

test('a page, and a frame from another site in it, are told this browser does not play HLS streams by itself', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = (await b.state()).tabs.find((t) => t.active);
  await b.ui('tab:js', { id: tab.id, code: `location.href = ${JSON.stringify(b.base + '/hls-outer.html')}; 1` });
  let outer, inner;
  for (const end = Date.now() + 8000; Date.now() < end && !(outer && inner); await sleep(100)) {
    outer = await b.ui('tab:js', { id: tab.id, code: 'document.title === "HLS outer" && window.says' }).catch(() => null);
    inner = await b.ui('frame:js', { id: tab.id, match: 'hls-inner', code: 'window.says' }).catch(() => null);
    if (typeof inner !== 'object') inner = null;
  }
  assert.deepEqual([outer.hls, outer.hls2], ['', ''], 'so a player streams through its own script, as in Chrome');
  assert.notEqual(outer.mp4, '', 'everything else is answered as before');
  assert.equal(inner.hls, '', 'an embedded player too');
  assert.notEqual(inner.mp4, '');
});
