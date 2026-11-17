// Runs inside every page Claude touches, in an isolated world: it shares the
// DOM with the page but not its JavaScript, so the page can neither see nor
// break it. Installed lazily (the main process prepends this file to each
// call), so it must be safe to evaluate more than once.
//
// No innerHTML and no <style> tags here: both can be blocked by a page's
// Content Security Policy or Trusted Types. Styles go through the CSSOM.
(() => {
  if (globalThis.__loui) return;

  const MAGENTA = '#C2338F';

  // ── refs ────────────────────────────────────────────────────────────────
  const byRef = new Map();
  const refs = new WeakMap();
  let seq = 0;
  const refOf = (el) => {
    let id = refs.get(el);
    if (!id) {
      id = 'e' + ++seq;
      refs.set(el, id);
      byRef.set(id, new WeakRef(el));
    }
    return id;
  };
  const elOf = (ref) => {
    const el = byRef.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  };

  const clean = (s, max = 120) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  const q = (s) => JSON.stringify(s);

  // ── what an element is ──────────────────────────────────────────────────
  const ACTION_ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider',
    'spinbutton', 'treeitem',
  ]);
  const REGION_TAGS = {
    NAV: 'navigation', MAIN: 'main', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside',
    FORM: 'form', DIALOG: 'dialog', TABLE: 'table',
  };
  const REGION_ROLES = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'search',
    'dialog', 'alertdialog', 'menu', 'menubar', 'tablist', 'toolbar', 'listbox', 'region',
    'alert', 'status',
  ]);
  const GROUP_TAGS = { LI: 'item', TR: 'row', ARTICLE: 'article' };
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'HR', 'WBR',
  ]);
  // An element with none of these inside is read as one run of text.
  const NOT_PLAIN =
    'a[href],button,input,select,textarea,summary,iframe,img[alt],[role],[onclick],' +
    '[tabindex],[contenteditable],h1,h2,h3,h4,h5,h6,p,div,li,tr,ul,ol,dl,table,section,' +
    'article,form,nav,main,header,footer,aside,dialog,details,pre,blockquote';

  function roleOf(el) {
    const role = el.getAttribute('role');
    if (role && ACTION_ROLES.has(role)) return role;
    switch (el.tagName) {
      case 'A': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return 'select';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return null;
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'range') return 'slider';
        if (t === 'file') return 'file-input';
        return 'textbox';
      }
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return null;
  }

  // Things that take clicks without saying so: onclick, tabindex, or the
  // topmost element of a cursor:pointer region.
  function looksClickable(el, style) {
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
    if (style.cursor !== 'pointer') return false;
    const p = el.parentElement;
    return !p || getComputedStyle(p).cursor !== 'pointer';
  }

  function regionOf(el) {
    const role = el.getAttribute('role');
    if (role && REGION_ROLES.has(role)) return role;
    if (el.tagName === 'SECTION') return el.hasAttribute('aria-label') ? 'region' : null;
    return REGION_TAGS[el.tagName] || null;
  }

  // A label's own words, without the text of a control nested inside it.
  function labelText(label) {
    let s = '';
    const texts = label.ownerDocument.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n = texts.nextNode(); n; n = texts.nextNode()) {
      if (!n.parentElement.closest('select,textarea,button')) s += n.nodeValue + ' ';
    }
    return s;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el.labels?.length) return clean([...el.labels].map(labelText).join(' '));
    const tag = el.tagName;
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || el.type);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    const text = clean(el.innerText ?? el.textContent);
    if (text) return text;
    const inner = el.querySelector('img[alt],[aria-label],[title]');
    return clean(
      inner?.getAttribute('alt') || inner?.getAttribute('aria-label') ||
      inner?.getAttribute('title') || el.getAttribute('title') || '',
    );
  }

  function brief(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/)[0];
    return s;
  }

  function describe(el, role) {
    let s = `${role} ${q(nameOf(el))} [${refOf(el)}]`;
    if (role === 'link') {
      let href = el.getAttribute('href') || '';
      try {
        const u = new URL(href, el.baseURI);
        href = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
      } catch {}
      if (href) s += ` -> ${clean(href, 90)}`;
    } else if (role === 'select') {
      s += ` value=${q(clean(el.selectedOptions?.[0]?.textContent))}`;
      const opts = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 30));
      s += ` options=${q(opts)}${el.options.length > 12 ? '…' : ''}`;
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = el.getAttribute('type');
      if (t && t !== 'text' && role === 'textbox') s += ` type=${t}`;
      if (role === 'checkbox' || role === 'radio') s += el.checked ? ' (checked)' : '';
      else if (el.value) s += ` value=${q(el.type === 'password' ? '••••' : clean(el.value, 80))}`; // never a password's characters
    } else if (role === 'textbox') {
      const v = clean(el.innerText, 80);
      if (v && v !== nameOf(el)) s += ` value=${q(v)}`;
    }
    const checked = el.getAttribute('aria-checked');
    if (checked === 'true') s += ' (checked)';
    if (el.getAttribute('aria-expanded') === 'true') s += ' (expanded)';
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) s += ' (current)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' (disabled)';
    return s;
  }

  // ── snapshot ────────────────────────────────────────────────────────────
  const indent = (lines) => lines.map((l) => '  ' + l);

  function childrenOf(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes();
      if (assigned.length) return assigned;
    }
    return el.childNodes;
  }

  function walkChildren(el, quiet, st) {
    const out = [];
    for (const k of childrenOf(el)) {
      if (st.cut) break;
      walk(k, quiet, st, out);
    }
    return out;
  }

  // quiet: the text of this subtree has already been reported by an ancestor,
  // so only report the things in it that can be acted on.
  function walk(node, quiet, st, out) {
    const push = (line) => {
      st.chars += line.length + 8;
      if (st.chars > st.max) st.cut = true;
      else out.push(line);
    };
    if (node.nodeType === 3) {
      if (quiet) return;
      const t = clean(node.nodeValue, 240);
      if (t) push(`text ${q(t)}`);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag) || el === host) return;
    const style = getComputedStyle(el);
    // display:contents has no box of its own, which checkVisibility reads as hidden.
    if (style.display !== 'contents' && !el.checkVisibility({ visibilityProperty: true })) return;

    if (tag === 'svg') {
      const label = el.getAttribute('aria-label') || el.querySelector('title')?.textContent;
      if (label && !quiet) push(`img ${q(clean(label))}`);
      return;
    }
    const role = roleOf(el);
    if (role) return push(describe(el, role));
    // A label's text is already the name of its control.
    if (tag === 'LABEL' && el.control) return out.push(...walkChildren(el, true, st));

    if (/^H[1-6]$/.test(tag)) {
      if (!quiet) push(`heading${tag[1]} ${q(clean(el.innerText, 200))}`);
      out.push(...indent(walkChildren(el, true, st)));
      return;
    }
    if (tag === 'IMG') {
      const alt = clean(el.getAttribute('alt'));
      if (alt && !quiet) push(`img ${q(alt)}`);
      return;
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      const label = q(clean(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('src'), 80));
      push(`iframe ${label} [${refOf(el)}]${doc?.body ? '' : ' (another site: contents not readable)'}`);
      if (doc?.body) out.push(...indent(walkChildren(doc.body, quiet, st)));
      return;
    }
    const region = regionOf(el);
    if (region) {
      const inner = walkChildren(el, quiet, st);
      if (!inner.length) return;
      const label = el.getAttribute('aria-label');
      push(`${region}${label ? ' ' + q(clean(label, 60)) : ''} [${refOf(el)}]`);
      out.push(...indent(inner));
      return;
    }
    if (looksClickable(el, style)) {
      push(`clickable ${q(nameOf(el))} [${refOf(el)}]`);
      out.push(...indent(walkChildren(el, true, st)));
      return;
    }
    if (GROUP_TAGS[tag]) {
      const inner = walkChildren(el, quiet, st);
      if (inner.length > 1) {
        out.push(GROUP_TAGS[tag]);
        out.push(...indent(inner));
      } else out.push(...inner);
      return;
    }
    if (!quiet && !el.shadowRoot && el.childElementCount && !el.querySelector(NOT_PLAIN)) {
      const t = clean(el.innerText, 400);
      if (t) push(`text ${q(t)}`);
      return;
    }
    out.push(...walkChildren(el, quiet, st));
  }

  function snapshot({ ref, max = 24000 } = {}) {
    const st = { chars: 0, max, cut: false };
    let lines = [];
    if (ref) {
      const el = elOf(ref);
      if (!el) return { error: 'stale' };
      walk(el, false, st, lines);
    } else {
      lines = walkChildren(document.body || document.documentElement, false, st);
    }
    const root = document.scrollingElement || document.documentElement;
    return {
      title: document.title,
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(root.scrollTop), max: Math.max(0, root.scrollHeight - innerHeight) },
      text: lines.join('\n'),
      cut: st.cut,
    };
  }

  // ── finding things on screen ────────────────────────────────────────────
  // Rect in top-window viewport coordinates, through same-origin iframes.
  function rectOf(el) {
    const rs = el.getClientRects();
    const r = rs.length > 1 ? rs[0] : el.getBoundingClientRect();
    let x = r.left, y = r.top;
    for (let w = el.ownerDocument.defaultView; w && w !== window; w = w.parent) {
      const f = w.frameElement;
      if (!f) break;
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
    }
    return { x, y, w: r.width, h: r.height };
  }

  function deepElementFromPoint(x, y) {
    let doc = document, el = null;
    for (;;) {
      let hit = doc.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit) return el;
      el = hit;
      if (el.tagName !== 'IFRAME') return el;
      let inner = null;
      try { inner = el.contentDocument; } catch {}
      if (!inner) return el;
      const fr = el.getBoundingClientRect();
      x -= fr.left + el.clientLeft;
      y -= fr.top + el.clientTop;
      doc = inner;
    }
  }

  // contains() that crosses shadow roots.
  function holds(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── what an action would set off (for guardrails, src/main/guardrails.js) ─
  // Facts only; the main process decides what counts as consequential.
  // Kinds of field that make submitting a form consequential.
  function fieldKind(f) {
    const ac = (f.getAttribute('autocomplete') || '').toLowerCase();
    const type = (f.getAttribute('type') || '').toLowerCase();
    const id = `${f.getAttribute('name') || ''} ${f.id || ''}`.toLowerCase();
    if (type === 'password' || /\b(current|new)-password\b/.test(ac)) return 'password';
    if (/\bcc-(number|csc|exp)/.test(ac) || /card.?(number|num|no)\b|cc.?num|\bcvv|\bcvc|\bcsc\b/.test(id)) return 'card';
    if (/\bone-time-code\b/.test(ac)) return 'otp';
    return null;
  }
  function fieldsIn(root) {
    const has = {};
    for (const f of root.querySelectorAll('input')) {
      const k = fieldKind(f);
      if (k) has[k] = true;
    }
    return has;
  }
  const TEXT_INPUT = /^(|text|email|password|search|tel|url|number|date|datetime-local|month|week|time)$/;
  // how: 'click' (a click, or Space on a focused control) or 'enter' (Enter in it).
  function guardOf(el, how = 'click') {
    const t = el.closest('button,a[href],input,select,textarea,summary,[role=button],[role=link],[role=menuitem]') || el;
    const role = roleOf(t) || t.tagName.toLowerCase();
    const type = (t.getAttribute('type') || '').toLowerCase();
    const form = t.form || t.closest('form');
    let submits = false;
    if (form) {
      if (t.tagName === 'BUTTON') submits = type === '' || type === 'submit';
      else if (t.tagName === 'INPUT') {
        submits = type === 'submit' || type === 'image' || (how === 'enter' && TEXT_INPUT.test(type));
      }
    }
    return {
      role, name: nameOf(t), submits, form: form ? fieldsIn(form) : {},
      href: t.closest('a[href]')?.href || null,
    };
  }
  function guardAt({ x, y }) {
    const el = deepElementFromPoint(x, y);
    return el ? guardOf(el) : null;
  }
  function guardFocus({ how }) {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    while (a?.tagName === 'IFRAME') {
      try { a = a.contentDocument?.activeElement; } catch { a = null; }
    }
    return a && a !== document.body ? guardOf(a, how) : null;
  }
  const guardPage = () => fieldsIn(document);

  function locate({ ref, scroll = true, how = 'click' }) {
    let el = elOf(ref);
    if (!el) return { error: 'stale' };
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = nameOf(el);
    const guard = guardOf(el, how);
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    let r = rectOf(el);
    // Restyled checkboxes and radios hide the real input; aim at its label.
    if (r.w < 1 && r.h < 1 && el.labels?.[0]) {
      el = el.labels[0];
      r = rectOf(el);
    }
    if (r.w < 1 && r.h < 1) return { error: 'hidden', name };
    const x = clamp(r.x + r.w / 2, 1, innerWidth - 2);
    const y = clamp(r.y + r.h / 2, 1, innerHeight - 2);
    const hit = deepElementFromPoint(x, y);
    const covered = hit && !holds(el, hit) && !holds(hit, el) ? brief(hit) : null;
    return { x, y, rect: r, role, name, covered, guard };
  }

  // ── Claude's pointer ────────────────────────────────────────────────────
  let host = null, cursor = null, ring = null, tagEl = null;
  let at = null, idleTimer = 0, ringTimer = 0;

  const css = (el, props) => Object.assign(el.style, props);
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ensureOverlay() {
    if (host?.isConnected) {
      // Re-enter the top layer so a newly opened modal doesn't sit over us.
      try { host.hidePopover(); host.showPopover(); } catch {}
      return;
    }
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.popover = 'manual';
    css(host, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh', maxWidth: 'none',
      maxHeight: 'none', margin: '0', padding: '0', border: '0', background: 'transparent',
      overflow: 'hidden', pointerEvents: 'none', zIndex: '2147483647', color: 'inherit',
    });

    ring = document.createElement('div');
    css(ring, {
      position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
      border: `2px solid ${MAGENTA}`, borderRadius: '5px',
      boxShadow: '0 0 0 1px rgba(255,255,255,.9), 0 0 0 5px rgba(194,51,143,.18)',
      opacity: '0', pointerEvents: 'none',
    });
    tagEl = document.createElement('div');
    css(tagEl, {
      position: 'absolute', left: '-2px', bottom: '100%', marginBottom: '4px',
      padding: '1px 7px 2px', borderRadius: '4px', background: MAGENTA, color: '#fff',
      font: 'italic 600 12px/1.4 system-ui, sans-serif', whiteSpace: 'nowrap',
      maxWidth: '60vw', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    ring.appendChild(tagEl);

    const NS = 'http://www.w3.org/2000/svg';
    cursor = document.createElementNS(NS, 'svg');
    cursor.setAttribute('width', '26');
    cursor.setAttribute('height', '30');
    cursor.setAttribute('viewBox', '0 0 26 30');
    css(cursor, {
      position: 'absolute', left: '0', top: '0', opacity: '0', pointerEvents: 'none',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))', willChange: 'transform',
    });
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M2 2 L2 23 L8 17.5 L12 27 L16 25.3 L12 16 L20 16 Z');
    arrow.setAttribute('fill', MAGENTA);
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.8');
    arrow.setAttribute('stroke-linejoin', 'round');
    cursor.appendChild(arrow);

    host.append(ring, cursor);
    document.documentElement.appendChild(host);
    try { host.showPopover(); } catch {}
  }

  function showRing(r, label, sticky) {
    css(ring, {
      transform: `translate(${Math.round(r.x - 3)}px,${Math.round(r.y - 3)}px)`,
      width: Math.round(r.w + 6) + 'px', height: Math.round(r.h + 6) + 'px', opacity: '1',
      transition: 'none',
    });
    tagEl.textContent = label || '';
    tagEl.style.display = label ? '' : 'none';
    // Keep the label on screen when the element touches the top edge.
    css(tagEl, r.y < 26
      ? { bottom: 'auto', top: '100%', marginTop: '4px', marginBottom: '0' }
      : { bottom: '100%', top: 'auto', marginBottom: '4px', marginTop: '0' });
    clearTimeout(ringTimer);
    if (!sticky) {
      ringTimer = setTimeout(() => css(ring, { transition: 'opacity .4s', opacity: '0' }), 1100);
    }
  }

  // Glide the pointer to a point, optionally outlining what it is aimed at.
  // Resolves when the pointer has arrived.
  function pointAt({ x, y, rect, label, from, press }) {
    ensureOverlay();
    const start = at || from || { x: innerWidth / 2, y: innerHeight / 2 };
    const dist = Math.hypot(x - start.x, y - start.y);
    const ms = still() ? 0 : Math.min(420, 120 + dist * 0.4);
    at = { x, y };
    cursor.style.opacity = '1';
    const end = `translate(${x - 2}px,${y - 2}px)`;
    const glide = cursor.animate(
      [{ transform: `translate(${start.x - 2}px,${start.y - 2}px)` }, { transform: end }],
      { duration: ms, easing: 'cubic-bezier(.3,.7,.2,1)' },
    );
    cursor.style.transform = end;
    if (rect) showRing(rect, label);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => css(cursor, { transition: 'opacity .5s', opacity: '0' }), 4000);
    cursor.style.transition = 'none';
    // A page that isn't being painted never finishes animations; don't wait on it.
    const arrived = Promise.race([glide.finished, new Promise((r) => setTimeout(r, ms + 60))]);
    return arrived.then(() => {
      if (press && !still()) {
        cursor.animate(
          [{ scale: '1' }, { scale: '.82' }, { scale: '1' }],
          { duration: 180, easing: 'ease-out' },
        );
      }
      return at;
    }, () => at);
  }

  function overlay({ show }) {
    if (host) host.style.visibility = show ? '' : 'hidden';
    return true;
  }

  // ── the user pointing at something ──────────────────────────────────────
  function selectorOf(el) {
    const doc = el.ownerDocument;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) {
      if (n.id && doc.querySelectorAll('#' + CSS.escape(n.id)).length === 1) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      let s = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  function picked(el) {
    const html = el.outerHTML || '';
    return {
      ref: refOf(el),
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      name: nameOf(el),
      text: clean(el.innerText ?? el.textContent, 600),
      html: html.length > 1500 ? html.slice(0, 1500) + '…' : html,
      rect: rectOf(el),
    };
  }

  let endPick = null;

  // Turns the next click into "this one". Resolves with the element's
  // description, or null if the user pressed Escape or the pick was cancelled.
  // The overlay takes the mouse while this is on, so the page never sees the click.
  function pick() {
    cancelPick();
    ensureOverlay();
    return new Promise((resolve) => {
      css(host, { pointerEvents: 'auto', cursor: 'crosshair' });
      const under = (e) => {
        host.style.pointerEvents = 'none';
        const el = deepElementFromPoint(e.clientX, e.clientY);
        host.style.pointerEvents = 'auto';
        return el;
      };
      const move = (e) => {
        const el = under(e);
        if (el) showRing(rectOf(el), brief(el), true);
      };
      const finish = (value) => {
        host.removeEventListener('mousemove', move);
        host.removeEventListener('click', click);
        window.removeEventListener('keydown', key, true);
        css(host, { pointerEvents: 'none', cursor: '' });
        ring.style.opacity = '0';
        endPick = null;
        resolve(value);
      };
      const click = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = under(e);
        finish(el ? picked(el) : null);
      };
      const key = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };
      host.addEventListener('mousemove', move);
      host.addEventListener('click', click);
      window.addEventListener('keydown', key, true);
      endPick = finish;
    });
  }

  function cancelPick() {
    endPick?.(null);
    return true;
  }

  function pickAt({ x, y }) {
    const el = deepElementFromPoint(x, y);
    return el ? picked(el) : null;
  }

  // ── small actions that are steadier in script than as input events ──────
  function focus({ ref, selectAll }) {
    const el = elOf(ref);
    if (!el) return { error: 'stale' };
    let inside = false;
    for (let a = el.ownerDocument.activeElement; a; a = a.shadowRoot?.activeElement) {
      if (holds(el, a)) inside = true;
    }
    if (!inside) el.focus();
    if (selectAll) {
      if (typeof el.select === 'function') el.select();
      else {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const sel = el.ownerDocument.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    return { ok: true };
  }

  function choose({ ref, value }) {
    const el = elOf(ref);
    if (!el) return { error: 'stale' };
    if (el.tagName !== 'SELECT') return { error: 'not-select' };
    const want = value.trim().toLowerCase();
    const opt = [...el.options].find((o) => o.value === value) ||
      [...el.options].find((o) => o.textContent.trim().toLowerCase() === want);
    if (!opt) return { error: 'no-option', options: [...el.options].map((o) => clean(o.textContent, 40)) };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, chosen: clean(opt.textContent, 60) };
  }

  function scroll({ ref, direction, amount }) {
    let box = document.scrollingElement || document.documentElement;
    if (ref) {
      const el = elOf(ref);
      if (!el) return { error: 'stale' };
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
          box = n;
          break;
        }
      }
    }
    const page = box === document.scrollingElement ? innerHeight : box.clientHeight;
    const step = amount || Math.round(page * 0.85);
    const top = { up: box.scrollTop - step, down: box.scrollTop + step, top: 0, bottom: box.scrollHeight }[direction];
    box.scrollTo({ top, behavior: 'instant' });
    return { y: Math.round(box.scrollTop), max: Math.max(0, box.scrollHeight - page) };
  }

  // Resolves once the DOM has gone `quiet` ms without changing, or after `max` ms.
  // This is how Claude waits for a page to finish reacting before reading it.
  function calm({ quiet = 250, max = 1500 } = {}) {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        watcher.disconnect();
        clearTimeout(timer);
        clearTimeout(limit);
        resolve(true);
      };
      const watcher = new MutationObserver((changes) => {
        if (host && changes.every((c) => host.contains(c.target))) return; // our own pointer
        clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      watcher.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      timer = setTimeout(done, quiet);
      const limit = setTimeout(done, max);
    });
  }

  function hasText({ text }) {
    return (document.body?.innerText || '').includes(text);
  }

  globalThis.__loui = {
    snapshot, locate, pointAt, overlay, pick, cancelPick, pickAt, focus, choose, scroll, calm,
    hasText, guardAt, guardFocus, guardPage,
  };
})();
