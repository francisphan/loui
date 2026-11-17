// The two things on the start page that come from the web: the weather
// (Open-Meteo, which needs no key) and news headlines (RSS and Atom feeds).
//
// Loui itself fetches them, from the main process: not through any tab's
// session (no cookies go, none are kept), and never from the page, which has
// no network access at all (startpage.js). What comes back is kept in memory
// (the weather 30 minutes, the news 15) and asked for again only when a start
// page is being shown after that, however many tabs are opened. A fetch that
// fails is tried again after a few minutes, not on every new tab.
//
// The place is a name typed in Settings, turned into coordinates once and
// kept ("weatherPlace", "weatherAt"); Loui never asks where the machine is.
// Feeds are read by a small parser of its own: titles, links, sources and
// dates only, as text. A link that is not http or https is dropped.
const { app } = require('electron');

const WEATHER_MS = 30 * 60 * 1000;
const NEWS_MS = 15 * 60 * 1000;
const RETRY_MS = 3 * 60 * 1000; // after a fetch that failed
const TIMEOUT_MS = 6000;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADLINES = 8;
const DEFAULT_FEEDS = ['https://news.google.com/rss']; // redirects to the edition for the locale

// For the tests only: local stand-ins for the two Open-Meteo services.
const testing = (name) => (process.env.LOUI_TEST && process.env[name]) || null;
const FORECAST = () => testing('LOUI_WEATHER_URL') || 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = () => testing('LOUI_GEOCODE_URL') || 'https://geocoding-api.open-meteo.com/v1/search';

// WMO weather codes, as Open-Meteo gives them.
const SKY = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

// The body of an http(s) address as text: within TIMEOUT_MS, and MAX_BYTES at most.
async function get(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('not a web address');
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: '*/*' } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const parts = [];
  let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > MAX_BYTES) break;
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

// ── feeds ────────────────────────────────────────────────────────────────
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const entities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
  if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? all;
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  try { return String.fromCodePoint(code); } catch { return ''; }
});
// An element's content as plain text: CDATA as it stands, the rest with its
// entities read. Whatever markup that leaves is text, and is shown as text.
function textOf(raw) {
  let out = '', last = 0, m;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  while ((m = cdata.exec(raw))) {
    out += entities(raw.slice(last, m.index)) + m[1];
    last = cdata.lastIndex;
  }
  return (out + entities(raw.slice(last))).replace(/\s+/g, ' ').trim();
}
const inner = (block, name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1] ?? null;
const element = (block, name) => { const raw = inner(block, name); return raw == null ? '' : textOf(raw); };

// An RSS or Atom feed's items: [{ title, url, source, at }], in the feed's order.
function parseFeed(xml, feedUrl = '') {
  const items = [];
  const first = xml.search(/<(item|entry)[\s>]/i);
  let fallback = element(first < 0 ? xml : xml.slice(0, first), 'title');
  if (!fallback) { try { fallback = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch {} }
  for (const [block] of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const title = element(block, 'title').slice(0, 200);
    // Atom: <link href="…"> (the page itself, not rel="self" and the like); RSS: <link>…</link>.
    const links = [...block.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag);
    const atom = links.find((t) => /\bhref\s*=/.test(t) && (!/\brel\s*=/.test(t) || /\brel\s*=\s*["']alternate["']/.test(t)));
    const link = atom ? entities(/\bhref\s*=\s*["']([^"']*)["']/.exec(atom)?.[1] || '') : element(block, 'link');
    let url;
    try { url = new URL(link.trim()); } catch { continue; }
    if (!title || !/^https?:$/.test(url.protocol)) continue;
    const at = Date.parse(element(block, 'pubDate') || element(block, 'updated') || element(block, 'published') || element(block, 'dc:date')) || 0;
    const source = (element(block, 'source') || fallback || '').slice(0, 60);
    // Google News ends each title with " - " and the source, which is shown beside it anyway.
    const plain = source && title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title;
    items.push({ title: plain, url: url.href, source, at });
  }
  return items;
}

// Kept for ms once loaded (RETRY_MS if it failed); key: what the answer depends
// on. Several callers at once share one fetch.
function kept(ms, load) {
  let key = null, value = null, at = 0, pending = null, pendingKey = null;
  return {
    get(k) {
      if (k === key && value && Date.now() - at < (value.failed ? RETRY_MS : ms)) return Promise.resolve(value);
      if (pending && pendingKey === k) return pending;
      pendingKey = k;
      pending = load().catch(() => ({ failed: true })).then((v) => {
        if (pendingKey === k) { key = k; value = v; at = Date.now(); pending = null; }
        return v;
      });
      return pending;
    },
    forget() { key = null; value = null; },
  };
}

function createFeeds({ settings, save }) {
  const units = () => (['c', 'f'].includes(settings.weatherUnits) ? settings.weatherUnits : /-US$/i.test(app.getLocale()) ? 'f' : 'c');
  const place = () => {
    const p = settings.weatherAt;
    return p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
  };
  // The tests' start pages ask the web for nothing unless their settings name a feed.
  const feeds = () => (Array.isArray(settings.newsFeeds) ? settings.newsFeeds.filter((f) => typeof f === 'string' && /^https?:\/\//i.test(f))
    : process.env.LOUI_TEST ? [] : DEFAULT_FEEDS);

  const weather = kept(WEATHER_MS, async () => {
    const p = place();
    const u = units();
    const q = new URLSearchParams({
      latitude: p.lat, longitude: p.lon, current: 'temperature_2m,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min', temperature_unit: u === 'f' ? 'fahrenheit' : 'celsius',
      timezone: 'auto', forecast_days: 1,
    });
    const d = JSON.parse(await get(`${FORECAST()}?${q}`));
    const n = (v) => { if (!Number.isFinite(v)) throw new Error('no reading'); return Math.round(v); };
    return {
      place: p.name, now: n(d.current?.temperature_2m), sky: SKY[d.current?.weather_code] || '',
      high: n(d.daily?.temperature_2m_max?.[0]), low: n(d.daily?.temperature_2m_min?.[0]),
    };
  });

  const news = kept(NEWS_MS, async () => {
    const lists = await Promise.all(feeds().map((f) => get(f).then((xml) => parseFeed(xml, f), () => null)));
    if (lists.every((l) => !l)) return { failed: true };
    // A headline from each feed in turn, each feed in its own order.
    const items = [], seen = new Set();
    for (let i = 0; items.length < HEADLINES && lists.some((l) => l && l.length > i); i++) {
      for (const l of lists) {
        const item = l?.[i];
        if (!item || seen.has(item.url) || items.length >= HEADLINES) continue;
        seen.add(item.url);
        items.push(item);
      }
    }
    return { items };
  });

  return {
    units, feeds,
    place: () => place()?.name || '',
    // For a start page being served: null when there is no place yet, { failed } when it could not be had.
    weather: () => (place() ? weather.get(`${place().lat},${place().lon},${units()}`) : Promise.resolve(null)),
    news: () => (feeds().length ? news.get(feeds().join('\n')) : Promise.resolve(null)),
    // A place name as typed -> its coordinates, kept. False if no such place was found.
    async setPlace(name) {
      const text = String(name || '').trim().slice(0, 100);
      if (!text) {
        delete settings.weatherPlace;
        delete settings.weatherAt;
        save();
        return true;
      }
      let found;
      try {
        const q = new URLSearchParams({ name: text, count: 1, language: 'en', format: 'json' });
        found = JSON.parse(await get(`${GEOCODE()}?${q}`)).results?.[0];
      } catch { return false; }
      if (!found || !Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) return false;
      const label = [found.name, found.country_code === 'US' ? found.admin1 : found.country].filter(Boolean);
      settings.weatherPlace = text;
      settings.weatherAt = { name: [...new Set(label)].join(', ').slice(0, 80), lat: found.latitude, lon: found.longitude };
      save();
      return true;
    },
    setUnits(u) {
      if (!['c', 'f'].includes(u)) return;
      settings.weatherUnits = u;
      save();
    },
    addFeed(url) {
      const text = String(url || '').trim();
      let u;
      try { u = new URL(text); } catch { return; }
      if (!/^https?:$/.test(u.protocol) || feeds().includes(u.href)) return;
      settings.newsFeeds = [...feeds(), u.href];
      save();
    },
    removeFeed(url) {
      settings.newsFeeds = feeds().filter((f) => f !== url);
      save();
    },
  };
}

module.exports = { createFeeds, parseFeed };
