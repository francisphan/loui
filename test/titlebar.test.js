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
  // Louis, at the start of the row, is part of what the window is dragged by; nothing else is.
  for (const [name, , , , , region] of r.items) assert.equal(region, name === 'brand' ? 'drag' : 'no-drag', name);
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
    // Louis first where there is room for him; in a small window the toolbar needs it.
    assert.deepEqual(names.slice(0, 2), width > 900 ? ['brand', 'sidebar-toggle'] : ['sidebar-toggle', 'back']);
    for (const name of ['back', 'address-form', 'helm', 'menu']) assert.ok(names.includes(name), `${name} is in it: ${names}`);
    // Louis, at the start of the row, is part of what the window is dragged by; nothing else is.
  for (const [name, , , , , region] of r.items) assert.equal(region, name === 'brand' ? 'drag' : 'no-drag', name);
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

test('with vertical tabs in a small window a question has a row of its own, and nothing lies under the window buttons', async () => {
  await b.ui('tabs:layout', { vertical: true });
  await until(() => chrome(`document.getElementById('tabs').parentElement.id`), (p) => p === 'sidebar');
  await size(720, 600);
  await buttons(138);
  const mine = (await b.state()).tabs.find((t) => t.group === 'you');
  await b.ui('tab:select', mine.id);
  const s = b.as('q', 'Claude Code · quarterly research');
  await s.text('navigate', { url: b.base + '/second.html?q' });
  const asked = s.call('request_tab').catch(() => {});
  await until(() => chrome(`!document.getElementById('helm').hidden && document.getElementById('helm').parentElement.id`), (p) => p === 'helmrow');
  const r = await row('navrow');
  const names = r.items.map(([name]) => name);
  for (const name of ['address-form', 'panel-toggle', 'menu']) assert.ok(names.includes(name), `${name} is in the toolbar: ${names}`);
  clear(r, 138); // which also leaves the strip to drag the window by
  // The question is whole, in the chrome above the page, and the page starts under it.
  const helm = await chrome(`(() => { const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom)]; };
    return { helm: box('helm'), row: box('helmrow'), stage: box('stage'), bar: box('bar'), text: document.getElementById('helm-text').scrollWidth <= document.getElementById('helm-text').clientWidth + 1,
      buttons: [...document.querySelectorAll('#helm button')].filter((n) => !n.hidden).map((n) => n.textContent) }; })()`);
  assert.ok(helm.helm[0] >= helm.bar[0] && helm.helm[1] <= helm.bar[1] && helm.helm[2] >= 44, `the helm is under the toolbar, inside the bar: ${JSON.stringify(helm)}`);
  assert.equal(helm.stage[2], helm.row[3], 'the page starts under its row');
  assert.deepEqual(helm.buttons, ['Not now', 'Hand it over']);
  // With room for it, the question is in the toolbar.
  await size(1400, 600);
  await until(() => chrome(`document.getElementById('helm').parentElement.id`), (p) => p === 'navrow');
  clear(await row('navrow'), 138);
  const { prompt } = await b.state();
  await b.ui('prompt:answer', { id: prompt.id, value: false });
  await asked;
  // A session's own tab on screen in the small window: the state and the button, in the toolbar.
  await size(720, 600);
  const theirs = (await b.state()).tabs.find((t) => t.group === 'q');
  await b.ui('tab:select', theirs.id);
  await until(() => chrome(`[...document.getElementById('helm').children].filter((n) => !n.hidden && n.getBoundingClientRect().width > 0).map((n) => n.textContent).join('|')`),
    (said) => /^Idle\|.*Take over$/.test(said));
  const small = await row('navrow');
  assert.ok(small.items.some(([name]) => name === 'helm'), 'the helm is in the toolbar');
  clear(small, 138);
  assert.match(await chrome(`document.getElementById('helm').title`), /quarterly research/, 'its tooltip has what the row has no room for');
  s.end();
  await b.ui('tabs:layout', { vertical: false });
  await until(() => chrome(`document.getElementById('helm').parentElement.id`), (p) => p === 'tabrow');
});

test("the Claude panel's header stays on one line in a small window: the lamp alone, and a plus", async () => {
  const head = () => chrome(`(() => { const h = (id) => document.getElementById(id).getBoundingClientRect();
    return { height: Math.round(h('panel-head').height), panel: Math.round(h('panel').width), lamp: getComputedStyle(document.getElementById('link-text')).display,
      plus: Math.round(h('new-chat').width), spare: Math.round(h('panel-tools').left - h('panel-head').querySelector?.('h1')?.right || h('panel-tools').left - document.querySelector('#panel-head h1').getBoundingClientRect().right),
      tip: document.getElementById('link').title, name: document.getElementById('new-chat').textContent }; })()`);
  await size(1400, 600);
  const wide = await until(head, (h) => h.panel > 330);
  assert.deepEqual([wide.lamp !== 'none', wide.plus > 80], [true, true], 'whole where there is room');
  await size(720, 600);
  const small = await until(head, (h) => h.panel < 330 && h.lamp === 'none');
  assert.equal(small.height, wide.height, 'one line, as in a wide window');
  assert.ok(small.plus <= 28, `New conversation is a plus (${small.plus}px)`);
  assert.equal(small.name, 'New conversation', 'still named for a screen reader');
  assert.match(small.tip, /^Connection to other Claude sessions: \w/, 'the lamp says its state in its tooltip');
  assert.ok(small.spare >= 24, `with room for one more small button (${small.spare}px)`);
  await size(1400, 800);
});

test('the menu button has a short menu of its own, one level deep', async () => {
  await b.ui('go', b.base + '/second.html?menu');
  await until(() => b.state(), (s) => s.tabs.find((t) => t.active)?.title === 'Second' && !s.tabs.find((t) => t.active).loading);
  await pause(1300); // history is written a moment after the visit
  const menu = await b.ui('menu:button');
  assert.deepEqual(menu.map((i) => (Array.isArray(i) ? `${i[0]} ▸` : i)), [
    'New tab', 'New window', 'New private window', '-',
    'History ▸', 'Bookmarks ▸', 'Downloads', 'Passwords', '-',
    'Zoom: 100%', 'Zoom in', 'Zoom out', 'Reset zoom', 'Find in page…', 'Print…', '-',
    'Device size ▸', 'Developer tools', '-',
    'Claude ▸', '-',
    'Settings', menu.at(-1)]);
  assert.match(menu.at(-1), /^About Loui \d+\.\d+\.\d+/);
  // The device sizes and the developer tools are here, not in the toolbar.
  assert.equal(await chrome("document.getElementById('devtools')"), null);
  assert.equal(await chrome("document.getElementById('device').hidden"), true, 'the device button shows only while one is emulated');
  const sub = (name) => menu.find((i) => Array.isArray(i) && i[0] === name)[1];
  assert.equal(sub('History')[0], 'Second', 'the page just visited comes first');
  assert.deepEqual(sub('History').slice(-2), ['-', 'Show all history']);
  assert.deepEqual(sub('Claude'), ['Sessions', 'Claude panel', 'Take over', 'Watch in a small window']);
  // Its items act.
  await b.ui('menu:button', { click: 'Zoom in' });
  assert.ok((await b.ui('menu:button')).includes('Zoom: 110%'));
  await b.ui('menu:button', { click: 'Reset zoom' });
  assert.ok((await b.ui('menu:button')).includes('Zoom: 100%'));
  const before = (await b.state()).tabs.length;
  await b.ui('menu:button', { in: 'History', click: 'Second' });
  await until(() => b.state(), (s) => s.tabs.length === before + 1 && /second\.html/.test(s.tabs.find((t) => t.active).url));
  await b.ui('menu:button', { click: 'Find in page…' });
  await until(() => chrome(`document.getElementById('find').hidden`), (h) => h === false);
  await chrome(`document.getElementById('find-close').click()`);
  // The application menu keeps its eight menus, for Alt and the shortcuts.
  assert.deepEqual((await b.ui('menu')).map(([name]) => name), ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Tab', 'Claude', 'Help']);
});

test('a new window opens a little down and right of the one it came from, not on top of it', async () => {
  const from = (await b.state()).window.id;
  await b.ui('window:focus', from);
  const here = await b.ui('window:bounds', from);
  const id = await b.ui('window:new', {});
  const there = await b.ui('window:bounds', id);
  assert.ok(there.x !== here.x && there.y !== here.y, `${JSON.stringify(there)} is not at ${JSON.stringify(here)}`);
  const third = await b.ui('window:bounds', await b.ui('window:new', {}));
  assert.ok(third.x !== there.x && third.y !== there.y, 'nor is the next one on top of that');
  for (const w of await b.ui('windows')) if (w.id !== from) await b.ui('window:close', w.id);
  await until(() => b.ui('windows'), (list) => list.length === 1);
});
