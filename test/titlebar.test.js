// The top of the window: there is no title bar, so Loui's top row (the tab
// strip, or the toolbar with vertical tabs) spans the window, the system's
// window buttons are drawn over its right end, its empty part drags the
// window, and the application menu drops from a button in the toolbar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b?.close(); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, ms = 10000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
    last = await what();
    if (ok(last)) return last;
  }
  assert.fail(`gave up waiting; last saw ${JSON.stringify(last)}`);
}
const chrome = (code) => b.ui('chrome:eval', code);
const size = async (width, height) => {
  await chrome(`window.resizeTo(${width}, ${height})`);
  await until(() => chrome('window.innerWidth'), (w) => Math.abs(w - width) < 4);
};
// The room the window buttons take, as the system would report it (the tests
// have no say over what it draws): ui.css reads it from --wco.
const buttons = (px) => chrome(`document.documentElement.style.setProperty('--wco', '${px}px')`);
const REGION = `((n) => getComputedStyle(n).getPropertyValue('-webkit-app-region') || getComputedStyle(n).getPropertyValue('app-region'))`;
// A top row and what is drawn in it: [name, left, right, top, bottom, drag or no-drag] of each.
const row = (id) => chrome(`(() => {
  const box = (n) => { const r = n.getBoundingClientRect(); return [n.id || n.className, Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom), ${REGION}(n)]; };
  const top = document.getElementById(${JSON.stringify(id)});
  const edge = (name, side) => Math.round(document.getElementById(name).getBoundingClientRect()[side]);
  return { top: box(top), items: [...top.children].filter((n) => n.getBoundingClientRect().width > 0).map(box), width: innerWidth,
    panel: edge('panel', 'top'), stage: edge('stage', 'top'), bar: edge('bar', 'right') };
})()`);
// Everything in the row ends before the window buttons, with a strip left to drag the window by.
function clear(r, room) {
  for (const [name, , right] of r.items) {
    assert.ok(right <= r.width - room - 40, `${name} ends at ${right}, clear of the window buttons (from ${r.width - room}) and the strip before them`);
  }
}

let s1, s2;
test('the tab strip is the top of the window, across the panel too, and the panel starts under it', async () => {
  await size(1400, 800);
  await buttons(138);
  for (const q of ['one', 'two']) await b.ui('tab:new', `${b.base}/index.html?${q}`);
  const r = await until(() => row('tabrow'), (x) => x.items.some(([name]) => name === 'tabs'));
  assert.deepEqual(r.top.slice(1, 5), [0, r.width, 0, 40], 'from edge to edge, 40px tall');
  assert.equal(await chrome(`getComputedStyle(document.getElementById('panel')).display`), 'grid', 'with the Claude panel open');
  assert.equal(r.panel, 40, 'the panel starts under the top row');
  assert.ok(r.bar < r.width - 200, 'and the toolbar stops at the panel');
  const nav = await row('navrow');
  assert.deepEqual([nav.top[3], nav.top[4], nav.stage], [40, 84, 84], 'the toolbar under it, then the page');
  clear(r, 138);
});

test('the empty part of the top row drags the window; tabs and buttons do not', async () => {
  const r = await row('tabrow');
  assert.equal(r.top[5], 'drag');
  assert.ok(r.items.length >= 2);
  for (const [name, , , , , region] of r.items) assert.equal(region, 'no-drag', name);
  assert.equal(await chrome(`${REGION}(document.querySelector('#tabs .tab'))`), 'no-drag');
});

test('nothing lies under the window buttons, however full the strip or small the window', async () => {
  s1 = b.as('s1', 'Claude Code · release notes for the autumn update');
  s2 = b.as('s2', 'Claude Desktop · quarterly research');
  await s1.text('navigate', { url: b.base + '/second.html?1' });
  await s2.text('navigate', { url: b.base + '/second.html?2' });
  for (let i = 0; i < 12; i++) await b.ui('tab:new', `${b.base}/index.html?n${i}`);
  const theirs = (await b.state()).tabs.find((t) => t.group === 's1');
  await b.ui('tab:select', theirs.id); // the helm shows
  await until(() => chrome(`document.getElementById('helm').hidden`), (h) => h === false);
  for (const [width, room] of [[1400, 138], [720, 138], [720, 220], [1000, 0]]) {
    await size(width, 600);
    await buttons(room);
    await pause(300);
    const r = await row('tabrow');
    const names = r.items.map(([name]) => name);
    assert.ok(names.includes('helm') && names.includes('newtab'), `the helm and the new-tab button are in the row: ${names}`);
    clear(r, room);
  }
  // The page is exactly where the chrome says it is.
  await size(1400, 800);
  await buttons(138);
  const tab = (await b.state()).tabs.find((t) => t.active);
  const stage = () => chrome(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await until(async () => [(await b.ui('tab:place', tab.id)).view, await stage()], ([view, at]) => JSON.stringify(view) === JSON.stringify(at));
});

test('the menu button drops the application menu under itself, and Alt+F and F10 press it', async () => {
  const at = await chrome(`(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), n = m.parentElement.getBoundingClientRect();
    return { left: Math.round(r.left), bottom: Math.round(r.bottom), row: m.parentElement.id, last: m.parentElement.lastElementChild.id, inside: r.right <= n.right, title: m.title }; })()`);
  assert.deepEqual([at.row, at.last, at.inside, at.title], ['navrow', 'menu', true, 'Menu (Alt+F)']);
  assert.equal(await b.ui('menu:shown'), null);
  await chrome(`document.getElementById('menu').click()`);
  const shown = await until(() => b.ui('menu:shown'), (m) => m);
  assert.deepEqual([shown.x, shown.y], [at.left, at.bottom + 2]);
  for (const [key, modifiers] of [['F', ['alt']], ['F10', []]]) {
    await b.ui('menu:shown', 'forget');
    await b.ui('chrome:press', { key, modifiers });
    const again = await until(() => b.ui('menu:shown'), (m) => m);
    assert.equal(again.x, at.left, `${key} opens it at the button`);
  }
});

test('with no menu bar the shortcuts still work, and the window keeps its title', async () => {
  assert.equal((await b.ui('titlebar')).menuBar, false);
  const before = (await b.state()).tabs.length;
  await b.ui('chrome:press', { key: 'T', modifiers: ['control'] });
  await until(() => b.state(), (s) => s.tabs.length === before + 1);
  await b.ui('tab:new', b.base + '/second.html');
  await until(() => b.ui('titlebar'), (t) => t.title === 'Second · Loui');
});

test("the window buttons are drawn in the top row's colours and at its height, in either layout", async () => {
  const flat = await b.ui('titlebar');
  assert.deepEqual([flat.color, flat.symbolColor, flat.height], ['#101B22', '#E3EBEE', 40]); // dark, the default: the tab row's
  await b.ui('tabs:layout', { vertical: true });
  const side = await b.ui('titlebar');
  assert.deepEqual([side.color, side.height], ['#1A2832', 43]); // the toolbar's, less the rule under it
});

test('with vertical tabs the toolbar is the top row, with the helm in it, and the sidebar starts under it', async () => {
  await until(() => chrome(`document.getElementById('tabs').parentElement.id`), (p) => p === 'sidebar');
  const theirs = (await b.state()).tabs.find((t) => t.group === 's1');
  await b.ui('tab:select', theirs.id);
  await until(() => chrome(`document.getElementById('helm').hidden`), (h) => h === false);
  for (const [width, room] of [[1400, 138], [720, 138]]) {
    await size(width, 600);
    await buttons(room);
    await pause(300);
    const r = await row('navrow');
    assert.deepEqual(r.top.slice(1, 6), [0, r.width, 0, 44, 'drag'], 'the toolbar, from edge to edge');
    const names = r.items.map(([name]) => name);
    assert.equal(names[0], 'sidebar-toggle');
    for (const name of ['back', 'address-form', 'helm', 'menu']) assert.ok(names.includes(name), `${name} is in it: ${names}`);
    for (const [name, , , , , region] of r.items) assert.equal(region, 'no-drag', name);
    clear(r, room);
    const address = r.items.find(([name]) => name === 'address-form');
    assert.ok(address[2] - address[1] >= 100, `the address field is ${address[2] - address[1]}px wide`);
    assert.deepEqual([r.panel, r.stage], [44, 44], 'the panel and the page start under it');
    assert.equal(await chrome(`Math.round(document.getElementById('sidebar').getBoundingClientRect().top)`), 44);
    assert.equal(await chrome(`getComputedStyle(document.getElementById('tabrow')).display`), 'none', 'there is no tab row');
  }
  await b.ui('tabs:layout', { vertical: false });
  await until(() => chrome(`document.getElementById('helm').parentElement.id`), (p) => p === 'tabrow');
  for (const s of [s1, s2]) s.end();
});

test('a private window keeps its tint and its "Private" chip, in the top row', async () => {
  const id = await b.ui('window:new', { private: true });
  const inw = (code) => b.ui('in-window', { window: id, ui: 'chrome:eval', arg: code });
  await until(() => inw(`document.body.classList.contains('private')`).catch(() => false), (p) => p === true);
  const chip = await inw(`(() => { const c = document.getElementById('private-label'), r = c.getBoundingClientRect();
    return [c.parentElement.id, c.hidden, r.width > 30, r.bottom <= 40, ${REGION}(c)]; })()`);
  assert.deepEqual(chip, ['tabrow', false, true, true, 'no-drag']);
  const bar = await b.ui('in-window', { window: id, ui: 'titlebar' });
  assert.equal(bar.color, '#17152A');
  assert.match(bar.title, / · Private$/);
  await b.ui('tabs:layout', { vertical: true });
  await until(() => inw(`document.getElementById('private-label').parentElement.id`), (p) => p === 'navrow');
  await b.ui('tabs:layout', { vertical: false });
  await b.ui('window:close', id);
});
