// What each browser tool does. Every handler returns MCP content: an array of
// {type:'text'} and {type:'image'} blocks. `run` is the single entry point for
// both the control socket (Claude Code) and the in-browser chat.
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const TOOLS = require('../shared/tools');
const { toUrl, PRESETS, YOU } = require('./tabs');
const { createPicker } = require('./picker');
const { PAUSED } = require('./sessions');
const { articleText } = require('./reader');

const LIB = fs.readFileSync(path.join(__dirname, '../page/lib.js'), 'utf8');
const WORLD = 4812; // isolated world for LIB: same DOM as the page, separate JavaScript
const MAX_IMAGE_EDGE = 1568; // larger images are downscaled by the API anyway

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => [{ type: 'text', text: s }];
const jpeg = (img) => ({ type: 'image', data: img.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' });

const KEY_NAMES = {
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', esc: 'Escape',
  return: 'Enter', ' ': 'Space', spacebar: 'Space', del: 'Delete', pageup: 'PageUp',
  pagedown: 'PageDown',
};
const MODIFIERS = {
  control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta',
};

function parseKey(chord) {
  const parts = chord === '+' ? ['+'] : chord.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() || '';
  const modifiers = parts.map((p) => MODIFIERS[p.toLowerCase()]).filter(Boolean);
  return { keyCode: KEY_NAMES[key.toLowerCase()] || key, modifiers };
}

const shorten = (s, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const host = (u) => { try { return new URL(u).host || u; } catch { return u; } };
// The host and the start of the path, so two pages of one site read
// differently. Never the query, and no more than the first part of the path:
// the rest can hold secrets (a reset or invite link's token).
const place = (u) => {
  try {
    const { host, pathname } = new URL(u);
    const first = pathname.split('/')[1] || '';
    return host ? host + (first ? `/${first.length > 24 ? first.slice(0, 23) + '…' : first}` : '') : u;
  } catch { return u; }
};

// refuse(url): why sessions may not open an address (see brave.js), or null.
// guard: guardrails.js, which asks the user before consequential actions.
function createActions({ tabs, sessions, prompts, changed, refuse = () => null, guard }) {
  // The tab a session works in: its group's current tab. A session's first
  // tab is opened in the background the first time it needs one. A sleeping
  // or resting tab is woken (see tabs.use()).
  function need(session) {
    const tab = tabs.current(session.group);
    if (tab) return tabs.use(tab);
    if (session.group !== YOU) return tabs.create('', { group: session.group });
    throw new Error('None of your own tabs is open.');
  }

  // A new tab for the session. The Claude panel's opens beside the user's
  // current tab, or in the normal window used last: never in a private window,
  // whichever window happens to be focused.
  function fresh(session) {
    if (session.group !== YOU) return tabs.create('', { group: session.group });
    const window = tabs.current(YOU)?.window || tabs.normalWindow();
    if (!window || window.private) throw new Error('None of your own windows is open.');
    return tabs.create('about:blank', { group: YOU, window }); // blank, as a session's: not the user's start page
  }

  // Call a function from src/page/lib.js inside the tab.
  // A page that has hung would otherwise hold the call (and the session) for
  // good. Pointing is left unbounded: it waits for the user, and has its own limit.
  const page = (tab, fn, arg = {}) => {
    const call = tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [
      { code: `${LIB}\n;__loui.${fn}(${JSON.stringify(arg)})` },
    ]);
    if (fn === 'pick') return call;
    let timer;
    const late = new Promise((_, no) => {
      timer = setTimeout(() => no(new Error('The page did not respond within 15 seconds.')), 15000);
    });
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  };

  const check = (result, ref) => {
    if (result?.error === 'stale') throw new Error(`${ref} is no longer on the page. Take a new snapshot.`);
    if (result?.error === 'hidden') throw new Error(`${ref} ("${result.name}") has no visible box to act on.`);
    return result;
  };

  // Let the page react: wait out a navigation if one started, then wait for
  // the DOM to stop changing (bounded, since some pages never do).
  async function settle(tab, calm = { quiet: 250, max: 1500 }) {
    await sleep(100);
    if (tab.wc.isDestroyed()) return;
    if (tab.wc.isLoadingMainFrame()) {
      await Promise.race([
        new Promise((r) => tab.wc.once('did-stop-loading', r)),
        sleep(15000),
      ]);
    }
    await page(tab, 'calm', calm).catch(() => {});
  }

  async function outline(tab, ref) {
    let s;
    try {
      s = check(await page(tab, 'snapshot', { ref }), ref);
    } catch (e) {
      if (/no longer on the page/.test(e.message)) throw e;
      return `Page: ${tab.title}\nURL: ${tab.url}\n\n(This page can't be read as an outline. Try screenshot.)`;
    }
    // An error page's own address is Chromium's; the address that failed is the one that matters.
    const url = s.url.startsWith('chrome-error:') ? tab.url : s.url;
    return (
      `Page: ${s.title}\nURL: ${url}\n` +
      `Viewport ${s.viewport.w}x${s.viewport.h}, scrolled ${s.scroll.y} of ${s.scroll.max}px\n\n` +
      (s.text || '(nothing readable on this page)') +
      (s.cut ? '\n… outline cut off here. Snapshot a region by ref, or scroll.' : '')
    );
  }

  // After an action the active tab may have changed (a link opened a new one).
  async function after(c, tab, said) {
    await settle(tab);
    c.own(tab); // before need(), which would open a new tab in place of one taken back
    const now = c.need();
    if (now !== tab) {
      await settle(now);
      c.own(now);
      said += ` This opened a new tab (${now.id}), which is now active.`;
    }
    return text(`${said}\n\n${await outline(now)}`);
  }

  // Page coordinates are CSS pixels; input events are in view pixels.
  const toView = (tab, p) => {
    const k = tab.wc.getZoomFactor();
    return { x: Math.round(p.x * k), y: Math.round(p.y * k) };
  };

  async function aim(tab, target, label, press) {
    await tabs.settled(tab);
    tab.pointer = await page(tab, 'pointAt', {
      x: target.x, y: target.y, rect: target.rect, label, press, from: tab.pointer,
    }).catch(() => tab.pointer);
  }

  function mouse(tab, p, { button = 'left', double = false } = {}) {
    const at = toView(tab, p);
    tab.actedAt = Date.now(); // a page may open a tab on a click (tabs.mayOpen)
    tab.wc.sendInputEvent({ type: 'mouseMove', ...at });
    for (let n = 1; n <= (double ? 2 : 1); n++) {
      tab.wc.sendInputEvent({ type: 'mouseDown', ...at, button, clickCount: n });
      tab.wc.sendInputEvent({ type: 'mouseUp', ...at, button, clickCount: n });
    }
  }

  function key(tab, chord) {
    const { keyCode, modifiers } = parseKey(chord);
    // A key Claude presses is for the page. A shortcut the page leaves alone
    // would otherwise reach Loui's menu (Ctrl+D, Ctrl+W, ...) and act on the
    // tab the user has on screen. The page answers a moment later, so the
    // menu ignores this tab for a second.
    const wc = tab.wc; // the tab may sleep (and lose its page) within the second
    wc.setIgnoreMenuShortcuts(true);
    clearTimeout(tab.keysOwn);
    tab.keysOwn = setTimeout(() => { if (!wc.isDestroyed()) wc.setIgnoreMenuShortcuts(false); }, 1000);
    tab.actedAt = Date.now();
    tab.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // Text keys and Enter only take effect through a char event.
    const typed = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode.length === 1 ? keyCode : null;
    if (typed && !modifiers.some((m) => m !== 'shift')) {
      tab.wc.sendInputEvent({ type: 'char', keyCode: typed, modifiers });
    }
    tab.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  async function capture(tab, rect) {
    await page(tab, 'overlay', { show: false }).catch(() => {});
    await sleep(40);
    try {
      return await tab.wc.capturePage(rect);
    } finally {
      page(tab, 'overlay', { show: true }).catch(() => {});
    }
  }

  // A crop of the page around a rect given in CSS pixels.
  async function crop(tab, r, pad = 8) {
    const [vw, vh] = [tab.view.getBounds().width, tab.view.getBounds().height];
    const a = toView(tab, { x: r.x - pad, y: r.y - pad });
    const b = toView(tab, { x: r.x + r.w + pad, y: r.y + r.h + pad });
    const x = Math.max(0, a.x), y = Math.max(0, a.y);
    const width = Math.min(vw, b.x) - x, height = Math.min(vh, b.y) - y;
    if (width < 2 || height < 2) return null;
    return fit(await capture(tab, { x, y, width, height }), width, height);
  }

  function fit(img, width, height) {
    const k = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    return img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' });
  }

  async function fullPage(tab) {
    const dbg = tab.wc.debugger;
    dbg.attach('1.3'); // throws if DevTools is open on this tab
    try {
      const { cssContentSize: size } = await dbg.sendCommand('Page.getLayoutMetrics');
      const height = Math.min(size.height, 12000);
      const { data } = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'jpeg', quality: 82, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height, scale: 1 },
      });
      const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      return { img: fit(img, size.width, height), width: size.width, height, clipped: height < size.height };
    } finally {
      dbg.detach();
    }
  }

  // Guardrails: a consequential action waits here for the user, with a
  // picture of its target, before any input reaches the page. Throws the
  // session's tool error if the user declines (see guardrails.js).
  async function guarded(c, tab, found, rect, follows = true) {
    if (!found) return;
    c.say(`waiting for you to allow it to ${found.what}`);
    let image = null;
    if (rect) {
      const img = await crop(tab, rect, 16).catch(() => null);
      if (img) {
        const { width, height } = img.getSize();
        const k = Math.min(1, 360 / width, 140 / height);
        image = img.resize({ width: Math.round(width * k), height: Math.round(height * k) }).toDataURL();
      }
    }
    // Once answered the step is named for what it does, not for the wait.
    try {
      await guard.confirm(c.session, tab, found, image);
    } finally {
      c.say(found.what);
    }
    // What the page then does about the allowed action by itself (a handler
    // that clicks a hidden submit button from a timer) is not the doing of a
    // script that ran here earlier: the watch lets it by for a few seconds.
    // Not for a script, or for what a script sent: those are each asked about.
    if (follows && tab.watched && found.kind !== 'script' && tab.wc) await page(tab, 'pass', { ms: 4000 }).catch(() => {});
  }

  // A click (or the click that puts the caret in a field) goes to whatever is
  // at the point when it is sent, and that can change while the user is asked
  // and the pointer glides. So: judge, ask, glide, then look again, and send
  // the click only once what is there is nothing to ask about, or is what the
  // user just allowed. look(): the target as it is now (throws if it is gone);
  // judgeOf(target): what guardrails would ask about it.
  async function approach(c, tab, look, judgeOf, saying, label) {
    let target = await look();
    for (let round = 0, allowed; round < 3; round++) {
      const found = judgeOf(target);
      await guarded(c, tab, found, target.rect);
      if (found) allowed = found.what;
      c.say(saying(target));
      c.own(tab);
      await aim(tab, target, label, true);
      c.own(tab);
      target = await look();
      c.own(tab);
      const now = judgeOf(target);
      if (!now || now.what === allowed) return target;
    }
    throw new Error('The page kept changing what is under the pointer, so Loui did not click. Take a new snapshot.');
  }

  // What was stopped in the page since the last look (lib.js: a click, a
  // press, a submit or an Enter that a script sent to a control that may pay,
  // send or delete), judged like the same input from a tool. The watch is on
  // from a script's first run until the page is left (a new page has none).
  // during: the script's own call is still running, so the user is asked,
  // and what they allow is let through. Later it stays stopped and the
  // session is told: by then nobody can say whether a timer of the script's
  // or the page itself sent it.
  async function held(c, tab, during = false) {
    const r = await page(tab, 'caughtByScript').catch(() => null);
    if (!r?.on) tab.watched = false;
    const said = [], allowed = new Set();
    for (const h of r?.list || []) {
      const found = guard.judge(c.session, tab, h.info);
      if (found && !during) {
        const line = `After a script you ran in this page had returned, something (a timer it left, or the page itself) tried to ${found.what} without real input. Loui stopped it: use click or press_key instead, so the user can be asked.`;
        if (!said.includes(line)) said.push(line);
        continue;
      }
      // One press is several events (pointerdown, mousedown, click): asked once.
      if (found && !allowed.has(found.what)) {
        await guarded(c, tab, found, h.rect, false);
        c.own(tab);
        allowed.add(found.what);
        said.push(`Loui held the script's attempt to ${found.what} until the user allowed it.`);
      }
      await page(tab, 'release', { i: h.i }).catch(() => {});
    }
    return said.join('\n');
  }

  // Runs fn, which runs a script of Claude's in the page, under that watch.
  // Resolves { out: fn's result, note: what to tell the session }.
  // posts: whether a form the tab posts meanwhile is asked about (not for a
  // select that is all its form holds).
  async function watched(c, tab, fn, posts = true) {
    if (!guard.applies(c.session)) return { out: await fn(), note: '' };
    await page(tab, 'watchScript', guard.hints()).catch(() => {});
    guard.scripting(c.session, posts);
    tab.watched = true;
    let out, failed = null;
    try { out = await fn(); } catch (e) { failed = e; }
    await sleep(100); // what the script set off without waiting for it: a timer, a form on its way
    const note = tab.wc ? await held(c, tab, true) : '';
    if (failed) throw failed;
    return { out, note };
  }

  // session: the reader. A pick in one of the user's own tabs can be looked at
  // but not acted on until the tab is handed over.
  function describePick(p, session) {
    const ref = !p.live ? `${p.ref} (from an earlier page; the ref may be stale)`
      : session && p.group !== session.group ? "(in one of the user's own tabs: request_tab asks for it)"
        : p.ref;
    return (
      `Element the user pointed at, on ${p.url}\n` +
      `ref: ${ref}\n` +
      `selector: ${p.selector}\n` +
      (p.name ? `name: ${p.name}\n` : '') +
      (p.text ? `text: ${p.text}\n` : '') +
      `html: ${p.html}`
    );
  }

  const pickContent = (p, session) => [
    { type: 'text', text: describePick(p, session) },
    ...(p.image ? [{ type: 'image', data: p.image, mimeType: 'image/jpeg' }] : []),
  ];

  // name -> { label(args): what Claude is doing, shown to the user; run(args) }
  const handlers = {
    navigate: {
      label: (a) => `opening ${shorten(place(toUrl(a.url)))}`,
      async run({ url, new_tab }, c) {
        const to = toUrl(url);
        if (!/^(https?:|about:blank$)/i.test(to)) {
          throw new Error('Only http and https pages can be opened this way.');
        }
        const refused = refuse(to);
        if (refused) throw new Error(refused);
        const tab = new_tab ? fresh(c.session) : c.need();
        if (new_tab) tabs.setCurrent(c.session.group, tab.id);
        await guarded(c, tab, guard.judgeUrl(c.session, tab, to)).catch((e) => {
          if (new_tab) tabs.close(tab.id);
          throw e;
        });
        c.own(tab);
        const failed = await Promise.race([
          tab.wc.loadURL(to).then(() => null, (e) => e),
          sleep(20000).then(() => 'slow'),
        ]);
        const note = failed === 'slow' ? ' It is still loading.' : '';
        await settle(tab, { quiet: 350, max: 3000 });
        c.own(tab);
        return text(`Opened ${to}.${note}\n\n${await outline(tab)}`);
      },
    },

    history: {
      label: (a) => ({ back: 'going back', forward: 'going forward', reload: 'reloading' })[a.action],
      async run({ action }, c) {
        const tab = c.need();
        const h = tab.wc.navigationHistory;
        if (action === 'back' && !h.canGoBack()) throw new Error('There is no page to go back to.');
        if (action === 'forward' && !h.canGoForward()) throw new Error('There is no page to go forward to.');
        if (action === 'back') h.goBack();
        else if (action === 'forward') h.goForward();
        else tab.wc.reload();
        return after(c, tab, { back: 'Went back.', forward: 'Went forward.', reload: 'Reloaded.' }[action]);
      },
    },

    snapshot: {
      label: () => 'reading the page',
      run: async ({ ref }, c) => text(await outline(c.need(), ref)),
    },

    read_article: {
      label: () => 'reading the article',
      run: async (_args, c) => text(await articleText(c.need())),
    },

    click: {
      label: () => 'clicking',
      async run({ ref, x, y, double, button }, c) {
        const tab = c.need();
        let look, what;
        if (ref) {
          look = async () => check(await page(tab, 'locate', { ref }), ref);
          what = (t) => `${t.role} "${shorten(t.name)}"`;
        } else if (x != null && y != null) {
          const at = { x: x / tab.shotScale, y: y / tab.shotScale };
          look = async () => ({
            ...at, guard: await page(tab, 'guardAt', at).catch(() => null),
            rect: { x: at.x - 60, y: at.y - 24, w: 120, h: 48 },
          });
          what = () => `the point ${Math.round(x)},${Math.round(y)}`;
        } else throw new Error('click needs a ref, or x and y.');
        // What is on top of the element at the point is what the click reaches, so it is judged first.
        const judge = (t) => guard.judge(c.session, tab, t.over) || guard.judge(c.session, tab, t.guard);
        const target = await approach(c, tab, look, judge, (t) => `clicking ${what(t)}`, double ? 'double-click' : 'click');
        const note = target.covered ? ` Note: <${target.covered}> sits on top of it at the click point, so the click may have landed there instead.` : '';
        mouse(tab, target, { button, double });
        return after(c, tab, `Clicked ${what(target)}.${note}`);
      },
    },

    type: {
      label: () => 'typing',
      async run({ ref, text: value, clear, submit }, c) {
        const tab = c.need();
        const look = async () => check(await page(tab, 'locate', { ref, how: 'enter' }), ref);
        // The activity log keeps what was typed, except into password, card
        // and one-time-code fields, where it keeps only how much.
        const first = await look();
        if (value) c.note(first.secret ? `(${value.length} characters)` : value);
        // The field is clicked first, and that click reaches whatever is on top of it.
        const judge = (t) => guard.judge(c.session, tab, t.over) || (submit ? guard.judge(c.session, tab, t.guard) : null);
        const target = await approach(c, tab, look, judge, (t) => `typing into "${shorten(t.name || t.role)}"`, 'type');
        mouse(tab, target);
        await sleep(60);
        c.own(tab);
        check(await page(tab, 'focus', { ref, selectAll: !!clear }), ref);
        c.own(tab);
        if (clear && !value) key(tab, 'Delete');
        if (value) await tab.wc.insertText(value);
        c.own(tab);
        if (submit) key(tab, 'Enter');
        return after(c, tab, `Typed into ${target.role} "${shorten(target.name)}"${submit ? ' and pressed Enter' : ''}.`);
      },
    },

    press_key: {
      label: (a) => `pressing ${a.key}`,
      async run({ key: chord }, c) {
        const tab = c.need();
        // Enter or Space on a focused control acts like submitting or clicking it.
        const { keyCode } = parseKey(chord);
        if (keyCode === 'Enter' || keyCode === 'Space') {
          const info = await page(tab, 'guardFocus', { how: keyCode === 'Enter' ? 'enter' : 'click' }).catch(() => null);
          await guarded(c, tab, guard.judge(c.session, tab, info));
        }
        await tabs.settled(tab);
        c.own(tab);
        key(tab, chord);
        return after(c, tab, `Pressed ${chord}.`);
      },
    },

    hover: {
      label: () => 'pointing',
      async run({ ref }, c) {
        const tab = c.need();
        const target = check(await page(tab, 'locate', { ref }), ref);
        c.say(`pointing at "${shorten(target.name || target.role)}"`);
        await aim(tab, target, 'hover');
        c.own(tab);
        tab.wc.sendInputEvent({ type: 'mouseMove', ...toView(tab, target) });
        return after(c, tab, `Hovering over ${target.role} "${shorten(target.name)}".`);
      },
    },

    select_option: {
      label: (a) => `choosing "${shorten(a.value)}"`,
      async run({ ref, value }, c) {
        const tab = c.need();
        const target = check(await page(tab, 'locate', { ref }), ref);
        await aim(tab, target, 'choose');
        c.own(tab);
        // A select may act as soon as it changes (its script submits a form or
        // presses a button): that is watched like a script of Claude's own.
        // A form that holds nothing but the select (a sort or filter that
        // posts back) sends nothing worth asking about.
        const posts = await page(tab, 'filledBeside', { ref }).catch(() => true);
        const { out: r, note } = await watched(c, tab, async () => check(await page(tab, 'choose', { ref, value }), ref), posts);
        if (r.error === 'not-select') throw new Error(`${ref} is not a <select>. Click it instead.`);
        if (r.error === 'no-option') throw new Error(`No option "${value}". Options: ${r.options.join(' | ')}`);
        return after(c, tab, `Chose "${r.chosen}".${note ? ` ${note}` : ''}`);
      },
    },

    scroll: {
      label: (a) => `scrolling ${a.direction === 'top' || a.direction === 'bottom' ? 'to the ' + a.direction : a.direction}`,
      async run({ direction, ref, amount }, c) {
        const tab = c.need();
        const r = check(await page(tab, 'scroll', { direction, ref, amount }), ref);
        await sleep(150);
        c.own(tab);
        return text(`Scrolled to ${r.y} of ${r.max}px.\n\n${await outline(tab)}`);
      },
    },

    wait_for: {
      label: (a) => (a.text ? `waiting for "${shorten(a.text, 30)}"` : 'waiting'),
      async run({ text: want, text_gone: gone, seconds = 10 }, c) {
        const tab = c.need();
        const limit = Math.min(30, Math.max(0, seconds)) * 1000;
        if (!want && !gone) {
          await sleep(limit);
          return text(`Waited ${limit / 1000}s.`);
        }
        const start = Date.now();
        for (;;) {
          // The user may take the tab back during the wait: its page is then theirs.
          const has = (t) => { c.own(tab); return page(tab, 'hasText', { text: t }).catch(() => false); };
          if ((!want || (await has(want))) && (!gone || !(await has(gone)))) {
            c.own(tab);
            return text(`Done after ${((Date.now() - start) / 1000).toFixed(1)}s.\n\n${await outline(tab)}`);
          }
          if (Date.now() - start > limit) {
            throw new Error(`Still waiting after ${limit / 1000}s: ${want ? `"${want}" has not appeared` : `"${gone}" is still there`}.`);
          }
          await sleep(250);
        }
      },
    },

    screenshot: {
      label: () => 'taking a screenshot',
      async run({ ref, full_page }, c) {
        const tab = c.need();
        if (ref) {
          const target = check(await page(tab, 'locate', { ref }), ref);
          c.own(tab);
          const img = await crop(tab, target.rect);
          if (!img) throw new Error(`${ref} is not in view.`);
          return [{ type: 'text', text: `${target.role} "${shorten(target.name)}"` }, jpeg(img)];
        }
        if (full_page) {
          const shot = await fullPage(tab).catch(() => null);
          if (shot) {
            const note = shot.clipped ? `, first ${shot.height}px of a taller page` : '';
            return [{ type: 'text', text: `Whole page, ${shot.width}x${shot.height} CSS px${note}. Use refs, not x,y, to click from this image.` }, jpeg(shot.img)];
          }
        }
        const { width, height } = tab.view.getBounds();
        const k = tab.wc.getZoomFactor();
        const css = { w: Math.round(width / k), h: Math.round(height / k) };
        const img = fit(await capture(tab), css.w, css.h);
        tab.shotScale = img.getSize().width / css.w;
        const fallback = full_page ? ' (Whole-page capture is unavailable while DevTools is open, so this is the visible part.)' : '';
        return [{ type: 'text', text: `Visible page, ${img.getSize().width}x${img.getSize().height}. click accepts x,y in this image.${fallback}` }, jpeg(img)];
      },
    },

    tabs: {
      label: (a) => ({ list: 'checking tabs', new: 'opening a tab', select: 'switching tabs', close: 'closing a tab' })[a.action],
      acts: (a) => a.action !== 'list',
      async run({ action, id, url }, c) {
        const group = c.session.group;
        if (action === 'new') {
          const tab = fresh(c.session);
          tabs.setCurrent(group, tab.id);
          if (url) return handlers.navigate.run({ url }, c);
          return text(`Opened tab ${tab.id}.`);
        }
        if (action === 'select' || action === 'close') {
          if (tabs.get(id)?.group !== group) throw new Error(`No tab ${id} in your group.`);
          if (action === 'select') tabs.setCurrent(group, id);
          else if (tabs.get(id).lent) tabs.move(id, YOU); // the user's tab goes back to them
          else tabs.close(id);
        }
        const current = tabs.current(group);
        const list = tabs.summary().filter((t) => t.group === group)
          .map((t) => `${t.id === current?.id ? '>' : ' '} ${t.id}  ${t.title}  ${t.url}`);
        return text(list.length ? `Your tabs (> is the one you are working in):\n${list.join('\n')}` : 'You have no tabs open. navigate opens one.');
      },
    },

    request_tab: {
      label: () => 'asking for this tab',
      async run(_args, c) {
        if (c.session.group === YOU) return text("You already work in the user's own tabs.");
        const tab = await sessions.request(c.session);
        if (!tab) return text('The user did not hand over the tab.');
        return text(`The user handed you tab ${tab.id}. It is now the tab you are working in.\n\n${await outline(tab)}`);
      },
    },

    evaluate: {
      label: () => 'running a script',
      async run({ code }, c) {
        const tab = c.need();
        c.note(String(code)); // the activity log keeps its first line only
        // A script can do anything a click can (form.submit(), fetch), and
        // read what is typed in the page. On a page with card or password
        // fields it is asked about first, and so is one that reads like it
        // clicks, submits or calls a handler on a page with a control that
        // pays, sends or deletes (a handler called directly cannot be seen
        // later). What it clicks or submits is held and judged like a tool's
        // own input (watched), and what it sends is checked like any other
        // action's (see guardrails.js).
        if (guard.applies(c.session)) {
          const fields = await page(tab, 'guardPage').catch(() => null);
          const controls = guard.presses(code) ? await page(tab, 'guardControls', guard.hints()).catch(() => null) : null;
          await guarded(c, tab, guard.judgeScript(c.session, tab, fields, controls));
          c.own(tab);
        }
        // Errors thrown by the code come back as values, so a rejection here can
        // only mean the code did not parse as an expression: run it as a body.
        const wrap = (body) =>
          `(async () => { try { const v = await (async () => { ${body}\n })(); ` +
          `try { return { out: v === undefined ? 'undefined' : JSON.stringify(v, null, 1) ?? String(v) }; } ` +
          `catch { return { out: String(v) }; } } catch (e) { return { threw: String(e?.stack || e) }; } })()`;
        const { out: result, note } = await watched(c, tab, () => tab.wc.executeJavaScript(wrap(`return (${code}\n);`), true)
          .catch(() => tab.wc.executeJavaScript(wrap(code), true))
          .catch(() => { throw new Error('That code has a syntax error.'); }));
        if (result.threw) throw new Error(result.threw);
        const out = result.out;
        return text((note ? `${note}\n` : '') + (out.length > 20000 ? out.slice(0, 20000) + '\n… (cut off)' : out));
      },
    },

    console_logs: {
      label: () => 'reading the console',
      async run({ level = 'all', contains, limit = 50 }, c) {
        const tab = c.need();
        const rank = { warning: ['warning', 'error'], error: ['error'] }[level];
        const rows = tab.console.filter((m) =>
          m.mark || ((!rank || rank.includes(m.level)) && (!contains || m.text.includes(contains))));
        const lines = rows.slice(-limit).map((m) =>
          m.mark ? `--- ${m.text} ---`
            : `[${m.level}] ${m.text}${m.source ? `  (${m.source.split('/').pop()}:${m.line})` : ''}`);
        return text(lines.length ? lines.join('\n') : 'No console messages.');
      },
    },

    network_requests: {
      label: () => 'reading network activity',
      async run({ failed_only, contains, limit = 50 }, c) {
        const tab = c.need();
        const rows = tab.network.filter((r) =>
          r.mark || ((!failed_only || r.error || r.status >= 400) && (!contains || r.url.includes(contains))));
        const lines = rows.slice(-limit).map((r) =>
          r.mark ? `--- ${r.text} ---`
            : `${r.error ? 'FAILED ' + r.error : r.status}  ${r.method}  ${r.type}  ${r.ms == null ? '-' : r.ms + 'ms'}${r.cached ? ' (cache)' : ''}  ${shorten(r.url, 200)}`);
        const real = rows.filter((r) => !r.mark).length;
        return text(real ? lines.join('\n') : failed_only ? 'No failed requests.' : 'No requests recorded.');
      },
    },

    set_viewport: {
      // Named before the arguments are checked, so bad ones still read sensibly.
      label: (a) => (a.preset === 'desktop' ? 'restoring the full window'
        : PRESETS[a.preset] ? `switching to ${PRESETS[a.preset].label}`
          : !a.preset && a.width && a.height ? `switching to ${a.width}×${a.height}` : 'changing the page size'),
      async run({ preset, width, height, mobile }, c) {
        const tab = c.need();
        if (preset && preset !== 'desktop') tabs.setDevice(tab, preset);
        else if (!preset && width && height) tabs.setDevice(tab, { width, height, mobile: !!mobile });
        else if (preset === 'desktop') tabs.setDevice(tab, null);
        else throw new Error('Give a preset, or both width and height.');
        await settle(tab);
        c.own(tab);
        const size = await tab.wc.executeJavaScript('`${innerWidth}x${innerHeight}`');
        return text(`Viewport is now ${size}.`);
      },
    },

    picks: {
      label: () => 'looking at what you pointed at',
      async run(_args, c) {
        // A session sees only what the user pointed at in its own tabs; the
        // panel sees what they pointed at in theirs.
        const list = picker.recent().filter((p) => p.group === c.session.group);
        if (!list.length) return text('The user has not pointed at anything yet. ask_user_to_pick asks them to.');
        return list.flatMap((p) => pickContent(p, c.session));
      },
    },

    ask_user_to_pick: {
      label: () => 'asking you to point at something',
      async run({ message }, c) {
        const tab = c.need();
        // Waits its turn behind other sessions' questions (prompts.js), then
        // brings the tab on screen: the user has to see it to click in it.
        const p = await prompts.ask({
          kind: 'pick', session: c.session, message,
          begin(item) {
            if (tabs.get(tab.id) !== tab || !tab.wc) return prompts.answer(item.id, null); // closed while waiting
            tabs.select(tab.id);
            // Set aside for another question (prompts.next), this showing's pointing answers nothing.
            const turn = item.turn;
            const done = (found) => { if (item.turn === turn) prompts.answer(item.id, found); };
            picker.start(tab, message).then(done, () => done(null));
          },
          stop: () => picker.cancel(),
        });
        c.own(tab); // taken back while the crosshair was up: what they then point at is theirs
        return p ? pickContent(p, c.session) : text('The user did not pick anything (cancelled or timed out).');
      },
    },
  };

  guard.reads((tab) => page(tab, 'guardPage')); // for a request whose body cannot be read
  const picker = createPicker({ tabs, page, crop, changed });
  const defs = new Map(TOOLS.map((t) => [t.name, t]));

  // session: who is asking (see sessions.js). Tools act inside its tab group.
  async function run(name, args, session) {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const acts = handler.acts ? handler.acts(args) : defs.get(name).acts;
    return sessions.during(session, handler.label(args), acts, async (say, record = () => {}) => {
      const current = tabs.current(session.group);
      if (current?.asleep) await settle(tabs.use(current)); // its page is back before the tool reads it
      // While the tool runs, requests its tab makes are checked (guardrails.js);
      // what was stopped is told to the session with the tool's result.
      guard.begin(session);
      const stopped = async () => { await guard.drain(session); return guard.takeNotes(session).join('\n'); };
      // A call in flight checks this before each read of the page and each
      // input: the user can take a tab back, or take over, while it runs.
      const own = (tab) => {
        if (tabs.get(tab.id) !== tab) return; // closed: nothing of the user's is left in it
        // stopped: the user's doing, not a failure (sessions.js).
        if (tab.group !== session.group) throw Object.assign(new Error('The user took this tab back.'), { stopped: 'taken' });
        if (acts && tabs.group(session.group)?.paused) throw Object.assign(new Error(PAUSED), { stopped: 'paused' });
      };
      const c = { say, note: record, session, own, need: () => need(session) };
      // What was stopped in a page a script of an earlier call ran in (see
      // held), before this call and while it ran.
      const seen = (tab) => (tab?.watched && tab.wc && tabs.get(tab.id) === tab && tab.group === session.group
        ? held(c, tab).catch(() => '') : '');
      const late = await seen(current);
      // The Claude panel works in the user's own tabs: when it last did, for
      // what only the user may do there (certs.js).
      const stamp = () => { const t = tabs.current(session.group); if (t && session.group === YOU) t.panelAt = Date.now(); };
      stamp();
      try {
        const out = await handler.run(args, c);
        const note = [late, await seen(tabs.current(session.group)), await stopped()].filter(Boolean).join('\n');
        return note ? [...text(note), ...out] : out;
      } catch (e) {
        const note = [late, await stopped()].filter(Boolean).join('\n');
        if (note) e.message += `\n${note}`;
        throw e;
      } finally {
        stamp();
        guard.end(session);
      }
    });
  }

  return { run, picker, describePick };
}

module.exports = { createActions };
