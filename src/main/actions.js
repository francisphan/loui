// What each browser tool does. Every handler returns MCP content: an array of
// {type:'text'} and {type:'image'} blocks. `run` is the single entry point for
// both the control socket (Claude Code) and the in-browser chat.
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const TOOLS = require('../shared/tools');
const { toUrl, PRESETS, YOU } = require('./tabs');
const { createPicker } = require('./picker');

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

function createActions({ tabs, sessions, changed }) {
  // The tab a session works in: its group's current tab. A session's first
  // tab is opened in the background the first time it needs one.
  function need(session) {
    const tab = tabs.current(session.group);
    if (tab) return tab;
    if (session.group !== YOU) return tabs.create('', { group: session.group });
    throw new Error('None of your own tabs is open.');
  }

  // Call a function from src/page/lib.js inside the tab.
  const page = (tab, fn, arg = {}) =>
    tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [
      { code: `${LIB}\n;__loui.${fn}(${JSON.stringify(arg)})` },
    ]);

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
    return (
      `Page: ${s.title}\nURL: ${s.url}\n` +
      `Viewport ${s.viewport.w}x${s.viewport.h}, scrolled ${s.scroll.y} of ${s.scroll.max}px\n\n` +
      (s.text || '(nothing readable on this page)') +
      (s.cut ? '\n… outline cut off here. Snapshot a region by ref, or scroll.' : '')
    );
  }

  // After an action the active tab may have changed (a link opened a new one).
  async function after(c, tab, said) {
    await settle(tab);
    const now = c.need();
    if (now !== tab) {
      await settle(now);
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
    tab.pointer = await page(tab, 'pointAt', {
      x: target.x, y: target.y, rect: target.rect, label, press, from: tab.pointer,
    }).catch(() => tab.pointer);
  }

  function mouse(tab, p, { button = 'left', double = false } = {}) {
    const at = toView(tab, p);
    tab.wc.sendInputEvent({ type: 'mouseMove', ...at });
    for (let n = 1; n <= (double ? 2 : 1); n++) {
      tab.wc.sendInputEvent({ type: 'mouseDown', ...at, button, clickCount: n });
      tab.wc.sendInputEvent({ type: 'mouseUp', ...at, button, clickCount: n });
    }
  }

  function key(tab, chord) {
    const { keyCode, modifiers } = parseKey(chord);
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
      label: (a) => `opening ${shorten(host(toUrl(a.url)))}`,
      async run({ url, new_tab }, c) {
        const to = toUrl(url);
        if (!/^(https?:|about:blank$)/i.test(to)) {
          throw new Error('Only http and https pages can be opened this way.');
        }
        const tab = new_tab ? tabs.create('', { group: c.session.group }) : c.need();
        if (new_tab) tabs.setCurrent(c.session.group, tab.id);
        const failed = await Promise.race([
          tab.wc.loadURL(to).then(() => null, (e) => e),
          sleep(20000).then(() => 'slow'),
        ]);
        const note = failed === 'slow' ? ' It is still loading.' : '';
        await settle(tab, { quiet: 350, max: 3000 });
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

    click: {
      label: () => 'clicking',
      async run({ ref, x, y, double, button }, c) {
        const tab = c.need();
        let target, what, note = '';
        if (ref) {
          target = check(await page(tab, 'locate', { ref }), ref);
          what = `${target.role} "${shorten(target.name)}"`;
          if (target.covered) note = ` Note: <${target.covered}> sits on top of it at the click point, so the click may have landed there instead.`;
        } else if (x != null && y != null) {
          target = { x: x / tab.shotScale, y: y / tab.shotScale };
          what = `the point ${Math.round(x)},${Math.round(y)}`;
        } else throw new Error('click needs a ref, or x and y.');
        c.say(`clicking ${what}`);
        await aim(tab, target, double ? 'double-click' : 'click', true);
        mouse(tab, target, { button, double });
        return after(c, tab, `Clicked ${what}.${note}`);
      },
    },

    type: {
      label: () => 'typing',
      async run({ ref, text: value, clear, submit }, c) {
        const tab = c.need();
        const target = check(await page(tab, 'locate', { ref }), ref);
        c.say(`typing into "${shorten(target.name || target.role)}"`);
        await aim(tab, target, 'type', true);
        mouse(tab, target);
        await sleep(60);
        check(await page(tab, 'focus', { ref, selectAll: !!clear }), ref);
        if (clear && !value) key(tab, 'Delete');
        if (value) await tab.wc.insertText(value);
        if (submit) key(tab, 'Enter');
        return after(c, tab, `Typed into ${target.role} "${shorten(target.name)}"${submit ? ' and pressed Enter' : ''}.`);
      },
    },

    press_key: {
      label: (a) => `pressing ${a.key}`,
      async run({ key: chord }, c) {
        const tab = c.need();
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
        const r = check(await page(tab, 'choose', { ref, value }), ref);
        if (r.error === 'not-select') throw new Error(`${ref} is not a <select>. Click it instead.`);
        if (r.error === 'no-option') throw new Error(`No option "${value}". Options: ${r.options.join(' | ')}`);
        return after(c, tab, `Chose "${r.chosen}".`);
      },
    },

    scroll: {
      label: (a) => `scrolling ${a.direction === 'top' || a.direction === 'bottom' ? 'to the ' + a.direction : a.direction}`,
      async run({ direction, ref, amount }, c) {
        const tab = c.need();
        const r = check(await page(tab, 'scroll', { direction, ref, amount }), ref);
        await sleep(150);
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
          const has = (t) => page(tab, 'hasText', { text: t }).catch(() => false);
          if ((!want || (await has(want))) && (!gone || !(await has(gone)))) {
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
          const tab = tabs.create('', { group });
          tabs.setCurrent(group, tab.id);
          if (url) return handlers.navigate.run({ url }, c);
          return text(`Opened tab ${tab.id}.`);
        }
        if (action === 'select' || action === 'close') {
          if (tabs.get(id)?.group !== group) throw new Error(`No tab ${id} in your group.`);
          if (action === 'select') tabs.setCurrent(group, id);
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
        // Errors thrown by the code come back as values, so a rejection here can
        // only mean the code did not parse as an expression: run it as a body.
        const wrap = (body) =>
          `(async () => { try { const v = await (async () => { ${body}\n })(); ` +
          `try { return { out: v === undefined ? 'undefined' : JSON.stringify(v, null, 1) ?? String(v) }; } ` +
          `catch { return { out: String(v) }; } } catch (e) { return { threw: String(e?.stack || e) }; } })()`;
        const result = await tab.wc.executeJavaScript(wrap(`return (${code}\n);`), true)
          .catch(() => tab.wc.executeJavaScript(wrap(code), true))
          .catch(() => { throw new Error('That code has a syntax error.'); });
        if (result.threw) throw new Error(result.threw);
        const out = result.out;
        return text(out.length > 20000 ? out.slice(0, 20000) + '\n… (cut off)' : out);
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
      label: (a) => (a.preset === 'desktop' ? 'restoring the full window' : `switching to ${PRESETS[a.preset]?.label || `${a.width}×${a.height}`}`),
      async run({ preset, width, height, mobile }, c) {
        const tab = c.need();
        if (preset && preset !== 'desktop') tabs.setDevice(tab, preset);
        else if (!preset && width && height) tabs.setDevice(tab, { width, height, mobile: !!mobile });
        else if (preset === 'desktop') tabs.setDevice(tab, null);
        else throw new Error('Give a preset, or both width and height.');
        await settle(tab);
        const size = await tab.wc.executeJavaScript('`${innerWidth}x${innerHeight}`');
        return text(`Viewport is now ${size}.`);
      },
    },

    picks: {
      label: () => 'looking at what you pointed at',
      async run(_args, c) {
        // A session sees what the user pointed at in its own tabs and in theirs.
        const mine = (p) => p.group === c.session.group || p.group === YOU;
        const list = picker.recent().filter(mine);
        if (!list.length) return text('The user has not pointed at anything yet. ask_user_to_pick asks them to.');
        return list.flatMap((p) => pickContent(p, c.session));
      },
    },

    ask_user_to_pick: {
      label: () => 'asking you to point at something',
      async run({ message }, c) {
        const tab = c.need();
        tabs.select(tab.id); // the user has to see the tab to click in it
        const p = await picker.start(tab, message);
        return p ? pickContent(p, c.session) : text('The user did not pick anything (cancelled or timed out).');
      },
    },
  };

  const picker = createPicker({ tabs, page, crop, changed });
  const defs = new Map(TOOLS.map((t) => [t.name, t]));

  // session: who is asking (see sessions.js). Tools act inside its tab group.
  async function run(name, args, session) {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const acts = handler.acts ? handler.acts(args) : defs.get(name).acts;
    return sessions.during(session, handler.label(args), acts, (say) =>
      handler.run(args, { say, session, need: () => need(session) }));
  }

  return { run, picker, describePick };
}

module.exports = { createActions };
