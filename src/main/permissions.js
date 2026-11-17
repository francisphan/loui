// Site permissions: camera, microphone, location, notifications and screen
// sharing. A site in one of the user's tabs asks, and the user answers in the
// window chrome (a strip above the page, which no page can draw in or cover).
// The prompt names the site by its origin only; nothing the page supplies is
// shown.
//
// Tabs in a Claude session's group are refused without a prompt, including
// tabs the user lent to a session: a session must not get the user's camera.
//
// An answer lasts until the tab leaves the page, unless the user ticks
// "Remember for this site"; remembered answers are kept per origin in
// permissions.json in the profile and can be forgotten from the panel.
const fs = require('fs');
const path = require('path');
const { app, webContents: contents, desktopCapturer } = require('electron');
const { YOU } = require('./tabs');

// Granted to any tab without asking.
const ALWAYS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
// Screen sharing is asked every time, as in other browsers.
const REMEMBERED = new Set(['camera', 'microphone', 'geolocation', 'notifications']);
const NAMES = { camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', notifications: 'Notifications' };

// The test suite has no camera or microphone; Chromium's fake ones stand in.
if (process.env.LOUI_TEST) app.commandLine.appendSwitch('use-fake-device-for-media-stream');

// What a request asks for, as kinds the user answers for.
function kindsOf(permission, details) {
  if (permission === 'media') {
    const types = details?.mediaTypes || [];
    return [types.includes('video') && 'camera', types.includes('audio') && 'microphone'].filter(Boolean);
  }
  if (permission === 'display-capture') return ['screen'];
  if (permission === 'geolocation' || permission === 'notifications') return [permission];
  return [];
}

// "meet.google.com wants to …"
function wants(kinds) {
  if (kinds.includes('screen')) return 'see your whole screen';
  if (kinds.includes('camera') && kinds.includes('microphone')) return 'use your camera and microphone';
  return {
    camera: 'use your camera', microphone: 'use your microphone',
    geolocation: 'know your location', notifications: 'show notifications',
  }[kinds[0]];
}

// Only web origins can be asked about and remembered; file:, data: and the
// like are refused.
function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}
const siteOf = (origin) => new URL(origin).host;

function createPermissions({ ses, tabs, home, changed }) {
  const file = path.join(home, 'permissions.json');
  // origin -> { kind: 'allow' | 'block' }
  const saved = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } })();
  const save = () => fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  // tab id -> Map(`${origin} ${kind}` -> boolean): answers for the page now open in the tab.
  const visit = new Map();
  // tab id -> expiry: the user just allowed screen sharing in this tab.
  const screen = new Map();
  const pending = []; // { id, tabId, origin, top, kinds, waiters }
  let seq = 0;

  const tabOf = (wc) => (wc ? tabs.list.find((t) => t.wc === wc) : null);
  const yours = (tab) => !!tab?.wc && tab.group === YOU && !tab.wc.isDestroyed();

  // true, false, or undefined if the user has not answered for this kind.
  function answered(tab, origin, kind) {
    const now = visit.get(tab.id)?.get(`${origin} ${kind}`);
    if (now !== undefined) return now;
    const kept = saved[origin]?.[kind];
    return kept === undefined ? undefined : kept === 'allow';
  }

  function settle(p, ok) {
    const i = pending.indexOf(p);
    if (i < 0) return;
    pending.splice(i, 1);
    for (const done of p.waiters) done(ok);
    changed();
  }

  function onRequest(wc, permission, callback, details) {
    if (ALWAYS.has(permission)) return callback(true);
    const tab = tabOf(wc);
    const kinds = kindsOf(permission, details);
    const origin = originOf(details?.securityOrigin || details?.requestingUrl);
    if (!kinds.length || !origin || !yours(tab)) return callback(false);
    const allow = (ok) => {
      if (ok && kinds.includes('screen')) screen.set(tab.id, Date.now() + 10000);
      callback(ok);
    };
    const answers = kinds.map((k) => answered(tab, origin, k));
    if (answers.includes(false)) return allow(false);
    const ask = kinds.filter((k, i) => answers[i] !== true);
    if (!ask.length) return allow(true);
    // The same question already waiting is answered once, for every caller.
    const same = pending.find((p) => p.tabId === tab.id && p.origin === origin && p.kinds.join() === ask.join());
    if (same) return void same.waiters.push(allow);
    pending.push({ id: ++seq, tabId: tab.id, origin, top: originOf(tab.wc.getURL()), kinds: ask, waiters: [allow] });
    changed();
  }

  // Checks are how pages read a permission without asking (Notification.permission,
  // navigator.permissions.query), and how Chromium confirms one before use.
  function onCheck(wc, permission, requestingOrigin, details) {
    if (ALWAYS.has(permission)) return true;
    const tab = tabOf(wc);
    const origin = originOf(details?.securityOrigin || requestingOrigin);
    if (!origin || !yours(tab)) return false;
    if (permission === 'media') {
      const kinds = { video: ['camera'], audio: ['microphone'] }[details?.mediaType] || ['camera', 'microphone'];
      return kinds.some((k) => answered(tab, origin, k) === true);
    }
    if (permission === 'geolocation' || permission === 'notifications') return answered(tab, origin, permission) === true;
    return false;
  }

  // getDisplayMedia: the 'display-capture' request above has already asked the
  // user; this hands over the screen only if they just allowed it in this tab.
  function onDisplayMedia(request, callback) {
    let tab = null;
    try { tab = tabOf(request.frame && contents.fromFrame(request.frame)); } catch {}
    const until = tab && screen.get(tab.id);
    if (tab) screen.delete(tab.id);
    if (!yours(tab) || !until || until < Date.now()) return callback(null);
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0] } : null), () => callback(null));
  }

  // The user's answer, from the strip. id: the prompt they saw, so a click
  // meant for one prompt never answers the next.
  function answer({ id, allow, remember } = {}) {
    const p = pending.find((q) => q.id === id);
    if (!p) return;
    const tab = tabs.get(p.tabId);
    const ok = !!allow && yours(tab);
    if (tab) {
      if (!visit.has(tab.id)) visit.set(tab.id, new Map());
      // Screen sharing is asked again next time, unless the user said no.
      for (const k of p.kinds) if (k !== 'screen' || !ok) visit.get(tab.id).set(`${p.origin} ${k}`, ok);
    }
    if (remember && p.kinds.every((k) => REMEMBERED.has(k))) {
      saved[p.origin] = { ...saved[p.origin] };
      for (const k of p.kinds) saved[p.origin][k] = ok ? 'allow' : 'block';
      save();
    }
    settle(p, ok);
  }

  function forget({ origin, kind } = {}) {
    if (!saved[origin]) return;
    delete saved[origin][kind];
    if (!Object.keys(saved[origin]).length) delete saved[origin];
    save();
    changed();
  }

  // A tab that navigates or closes drops its questions and this page's answers.
  tabs.on('leaving', (tab) => {
    visit.delete(tab.id);
    screen.delete(tab.id);
    for (const p of pending.filter((q) => q.tabId === tab.id)) settle(p, false);
  });
  // A tab handed to a session can no longer be asked for anything.
  tabs.on('change', () => {
    for (const p of pending.filter((q) => !yours(tabs.get(q.tabId)))) settle(p, false);
  });

  ses.setPermissionRequestHandler(onRequest);
  ses.setPermissionCheckHandler(onCheck);
  ses.setDisplayMediaRequestHandler(onDisplayMedia);

  // For the window chrome: the question for the tab on screen, and the
  // remembered answers for review.
  function state() {
    const p = pending.find((q) => q.tabId === tabs.activeId);
    return {
      permission: p ? {
        id: p.id,
        site: siteOf(p.origin),
        within: p.top && p.top !== p.origin ? siteOf(p.top) : null,
        wants: wants(p.kinds),
        canRemember: p.kinds.every((k) => REMEMBERED.has(k)),
      } : null,
      sitePermissions: Object.entries(saved).filter(([origin]) => originOf(origin) === origin).flatMap(([origin, kinds]) =>
        Object.entries(kinds || {}).map(([kind, choice]) => ({
          origin, kind, site: siteOf(origin), name: NAMES[kind] || kind, allowed: choice === 'allow',
        }))),
    };
  }

  // Whether a tab has a question waiting (such a tab is not put to sleep).
  const asking = (tabId) => pending.some((p) => p.tabId === tabId);

  return { state, answer, forget, asking };
}

module.exports = { createPermissions };
