// "Point": the user clicks an element to show Claude which one they mean.
// Keeps the last few picks, each with a cropped screenshot.
const KEEP = 8;

function createPicker({ tabs, page, crop, changed }) {
  const list = [];
  let seq = 0;
  let current = null; // { tab, message, stop }

  async function add(tab, found) {
    if (!found) return null;
    const img = await crop(tab, found.rect).catch(() => null);
    const pick = {
      id: ++seq, tabId: tab.id, group: tab.group, url: tab.url, live: true, ...found,
      image: img ? img.toJPEG(82).toString('base64') : null,
      thumb: img ? img.resize({ height: 56 }).toDataURL() : null,
    };
    list.unshift(pick);
    list.length = Math.min(list.length, KEEP);
    changed();
    return pick;
  }

  function cancel() {
    if (!current) return;
    const was = current;
    current = null;
    page(was.tab, 'cancelPick').catch(() => {});
    was.stop(null);
    changed();
  }

  // Resolves with the pick, or null if the user cancelled or two minutes passed.
  async function start(tab, message = '') {
    cancel();
    const mine = { tab, message };
    const stopped = new Promise((r) => { mine.stop = r; });
    current = mine;
    tab.wc.focus(); // so Escape reaches the page
    changed();
    const timer = setTimeout(cancel, 120000);
    const found = await Promise.race([page(tab, 'pick').catch(() => null), stopped]);
    clearTimeout(timer);
    if (current === mine) current = null;
    changed();
    return add(tab, found);
  }

  // Pick whatever is at a point, in view pixels (from the context menu).
  async function at(tab, point) {
    const k = tab.wc.getZoomFactor();
    return add(tab, await page(tab, 'pickAt', { x: point.x / k, y: point.y / k }).catch(() => null));
  }

  tabs.on('leaving', (tab) => {
    for (const p of list) if (p.tabId === tab.id) p.live = false;
    if (current?.tab === tab) cancel();
  });
  tabs.on('change', () => {
    if (current && tabs.active() !== current.tab) cancel();
  });

  return {
    start, cancel, at,
    recent: () => list,
    get: (id) => list.find((p) => p.id === id),
    remove(id) {
      const i = list.findIndex((p) => p.id === id);
      if (i >= 0) list.splice(i, 1);
      changed();
    },
    state: () => ({ active: !!current, message: current?.message || '' }),
  };
}

module.exports = { createPicker };
