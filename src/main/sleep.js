// Sleeping tabs. A tab of the user's that has not been on screen for a while
// (15 minutes unless settings.json says otherwise) is put to sleep: its page
// is unloaded and its renderer's memory freed, while the tab strip keeps its
// title, icon and address. It loads again when selected or used by Claude.
//
// Never put to sleep: the tab on screen; pinned tabs; tabs in a Claude session's group;
// tabs playing sound, loading, asking for a permission or downloading; pages
// with form input the user has not sent; sites the user keeps awake.
//
// settings.json:
//   "sleepAfterMinutes": 15     0 turns sleeping off
//   "keepAwake": ["host", …]    sites never put to sleep (the tab menu adds them)
const { YOU } = require('./tabs');

const DEFAULT_MINUTES = 15;

// True if any field on the page differs from what the page loaded with, or
// an editable region has focus.
const EDITED = `(() => {
  const changed = (el) => {
    if (el.matches('input[type=hidden], input[type=submit], input[type=button], input[type=reset], input[type=image], input[type=file]')) return false;
    if (el.matches('input[type=checkbox], input[type=radio]')) return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT' && el.multiple) return [...el.options].some((o) => o.selected !== o.defaultSelected);
    if (el.tagName === 'SELECT') { // with no option marked selected, a drop-down starts on the first
      const marked = [...el.options].findLastIndex((o) => o.defaultSelected);
      return el.selectedIndex !== (marked >= 0 ? marked : el.size > 1 ? -1 : 0);
    }
    return el.value !== el.defaultValue;
  };
  return [...document.querySelectorAll('input, textarea, select')].some(changed) ||
    !!document.activeElement?.isContentEditable;
})()`;

function createSleep({ tabs, ses, settings, save, permissions }) {
  const downloading = new Map(); // webContents -> downloads running from it

  const minutes = () => {
    const m = Number(settings.sleepAfterMinutes ?? DEFAULT_MINUTES);
    return Number.isFinite(m) && m > 0 ? m : 0;
  };
  const keepAwake = () => (Array.isArray(settings.keepAwake) ? settings.keepAwake : []);
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

  // Each session: the user's, and each private one (main.js attaches those).
  const attach = (s) => s.on('will-download', (_e, item, wc) => {
    if (!wc) return;
    downloading.set(wc, (downloading.get(wc) || 0) + 1);
    item.once('done', () => {
      const left = (downloading.get(wc) || 1) - 1;
      if (left) downloading.set(wc, left);
      else downloading.delete(wc);
    });
  });
  attach(ses);

  // What can be told without asking the page. Asked by the user (the tab
  // menu), only these apply.
  function mayRest(tab) {
    return !tab.asleep && !!tab.wc && !tab.wc.isDestroyed() &&
      !tabs.onScreen(tab) && tab.group === YOU && !tab.pinned &&
      !tab.loading && !tab.peeking && !tab.wc.isCurrentlyAudible() &&
      !permissions.asking(tab.id) && !downloading.has(tab.wc);
  }

  // Whether the page (or any frame in it) holds form input. A page that does
  // not answer within two seconds is left awake, to be safe.
  async function edited(tab) {
    const frames = tab.wc.mainFrame.framesInSubtree;
    const asks = frames.map((f) => f.executeJavaScript(EDITED).catch(() => false));
    const late = new Promise((r) => setTimeout(() => r([true]), 2000));
    return (await Promise.race([Promise.all(asks), late])).some(Boolean);
  }

  let checking = false;
  async function check() {
    const now = Date.now();
    for (const tab of tabs.list) if (tabs.onScreen(tab)) tab.seenAt = now; // on screen in any window
    for (const tab of tabs.list) if (tab.group !== YOU) tab.seenAt = now; // in a session's hands
    tabs.restAll(); // a tab the Claude panel was busy in goes back to rest
    const limit = minutes() * 60000;
    if (!limit || checking) return;
    checking = true;
    try {
      const kept = new Set(keepAwake());
      for (const tab of [...tabs.list]) {
        if (now - (tab.seenAt || now) < limit || !mayRest(tab) || kept.has(hostOf(tab.url))) continue;
        if (await edited(tab)) continue;
        if (mayRest(tab)) tabs.sleep(tab); // still true after waiting on the page
      }
    } finally {
      checking = false;
    }
  }

  // Often enough that a tab sleeps within a quarter of the limit past it.
  const every = () => Math.min(30000, Math.max(200, (minutes() * 60000) / 4 || 30000));
  const schedule = () => { setTimeout(() => check().finally(schedule), every()); };
  schedule();

  function setKeepAwake(host, on) {
    const list = keepAwake().filter((h) => h !== host);
    if (on) list.push(host);
    settings.keepAwake = list;
    save();
    tabs.emit('change'); // the Settings window lists them
  }
  // 0: never.
  function setMinutes(m) {
    if (!Number.isFinite(m) || m < 0) return;
    settings.sleepAfterMinutes = m;
    save();
  }

  // "Sleep this tab now": the user's word is enough, unsent form input or not.
  const sleepNow = (id) => {
    const tab = tabs.get(id);
    return !!tab && mayRest(tab) && tabs.sleep(tab);
  };

  // Right-click on a tab in the tab strip.
  tabs.on('tab-menu', (tab, items) => {
    if (tab.group !== YOU) return;
    const host = hostOf(tab.url);
    items.push({ label: 'Sleep this tab now', enabled: mayRest(tab), click: () => sleepNow(tab.id) });
    // Not in a private tab: the choice is kept in settings.json, which would record the site.
    if (host && /^https?:/.test(tab.url) && !tab.private) {
      items.push({
        label: `Keep ${host} awake`, type: 'checkbox', checked: keepAwake().includes(host),
        click: (item) => setKeepAwake(host, item.checked),
      });
    }
  });

  return { check, sleepNow, mayRest, attach, setMinutes, setKeepAwake, prefs: () => ({ minutes: minutes(), keepAwake: keepAwake() }) };
}

module.exports = { createSleep };
