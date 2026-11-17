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
//
// Only the open web is fetched: an address on this machine or its network is
// refused, wherever a feed's address or a redirect from it points (get). And
// a private window's start page causes no fetch at all: it shows what is
// already kept, or nothing.
const { app } = require('electron');
const dns = require('dns');
const net = require('net');

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

// Addresses that are this machine or its network, not the web: loopback,
// private, link-local, carrier-grade NAT, multicast, and "no address".
const LOCAL = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) LOCAL.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) LOCAL.addSubnet(a, n, 'ipv6');
const local = (ip) => LOCAL.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4'); // an IPv4 address written as IPv6 is checked as IPv4
// For the tests only: the stand-ins' own host:port (comma-separated), which are on 127.0.0.1.
const stubs = () => (testing('LOUI_FEEDS_LOCAL') || '').split(',').filter(Boolean);

// The address as a URL if it is http(s) and on the open web; throws if not.
// The name is looked up first, so a public name for a private address is
// refused as well.
async function web(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('not a web address'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('not a web address');
  if (stubs().includes(u.host)) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const found = /(^|\.)localhost\.?$/i.test(host) ? [] : net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (!found.length || found.some((a) => local(a.address))) throw new Error('an address on this machine or its network');
  return u;
}

// The body of an http(s) address as text: within TIMEOUT_MS, and MAX_BYTES at
// most. Redirects are followed by hand, REDIRECTS at most, each one checked
// like the first address.
const REDIRECTS = 5;
async function get(url) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  for (let hops = 0; ; hops++) {
    const u = await web(url);
    res = await fetch(u, { signal, redirect: 'manual', headers: { accept: '*/*' } });
    const to = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!to) break;
    res.body?.cancel().catch(() => {});
    if (hops >= REDIRECTS) throw new Error('too many redirects');
    url = new URL(to, u).href;
  }
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

// The <item> or <entry> blocks of a feed, found by looking for each one's
// closing tag from where it opens: a feed of unclosed openings must not cost
// more than one pass (a pattern that scanned to the end from each one froze
// the browser for over a minute on a hostile 2 MB feed). At most PARSE_MAX
// characters and BLOCKS_MAX blocks are looked at.
const PARSE_MAX = 300 * 1024;
const BLOCKS_MAX = 50;
function blocks(xml) {
  const text = xml.length > PARSE_MAX ? xml.slice(0, PARSE_MAX) : xml;
  const lower = text.toLowerCase();
  const out = [];
  const open = /<(item|entry)[\s>]/gi;
  for (let m; out.length < BLOCKS_MAX && (m = open.exec(text));) {
    const close = `</${m[1].toLowerCase()}>`;
    const end = lower.indexOf(close, m.index);
    if (end < 0) break; // nothing closes from here on
    out.push(text.slice(m.index, end + close.length));
    open.lastIndex = end + close.length;
  }
  return out;
}

// An RSS or Atom feed's items: [{ title, url, source, at }], in the feed's order.
function parseFeed(xml, feedUrl = '') {
  const items = [];
  const first = xml.search(/<(item|entry)[\s>]/i);
  let fallback = element(first < 0 ? xml : xml.slice(0, first), 'title');
  if (!fallback) { try { fallback = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch {} }
  for (const block of blocks(xml)) {
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
    // What is kept for k, however old, without asking for anything.
    peek: (k) => (k === key && value && !value.failed ? value : null),
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
    // kept: only what is already here, with no fetch (a private window's start page).
    weather: (kept = false) => (!place() ? Promise.resolve(null)
      : weather[kept ? 'peek' : 'get'](`${place().lat},${place().lon},${units()}`)),
    news: (kept = false) => (!feeds().length ? Promise.resolve(null) : news[kept ? 'peek' : 'get'](feeds().join('\n'))),
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
