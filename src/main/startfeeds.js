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
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { pipeline } = require('stream');

const WEATHER_MS = 30 * 60 * 1000;
const NEWS_MS = 15 * 60 * 1000;
const RETRY_MS = 3 * 60 * 1000; // after a fetch that failed
const TIMEOUT_MS = 6000;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADLINES = 8;
const DEFAULT_FEEDS = ['https://news.google.com/rss']; // redirects to the edition for the locale
// Feeds offered in Settings to add with one press: general news, in English
// and in Spanish. Each answered with headlines when this list was written.
const KNOWN_FEEDS = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { name: 'BBC Mundo', url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  { name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada' },
  { name: 'La Nación', url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Clarín', url: 'https://www.clarin.com/rss/lo-ultimo/' },
  { name: 'Infobae', url: 'https://www.infobae.com/arc/outboundfeeds/rss/' },
];
// Where the weather is told in Fahrenheit.
const FAHRENHEIT = ['US', 'BS', 'BZ', 'KY', 'LR', 'PW', 'FM', 'MH'];
const PLACES = 5; // how many places of a name are offered to choose from

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
// The IPv4 address an IPv6 one stands for where a gateway turns one into the
// other: NAT64 (64:ff9b::/96, the last four bytes) and 6to4 (2002::/16, the
// four after the prefix). null for any other address.
function carried(ip) {
  let text;
  try { text = new URL(`http://[${ip}]`).hostname.slice(1, -1); } catch { return null; } // as hex groups, "::" once at most
  const [head, tail] = text.split('::').map((part) => (part ? part.split(':') : []));
  const g = [...head, ...Array(8 - head.length - (tail || []).length).fill('0'), ...(tail || [])].map((x) => parseInt(x, 16));
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}
const local = (ip) => {
  if (!net.isIPv6(ip)) return LOCAL.check(ip, 'ipv4');
  if (LOCAL.check(ip, 'ipv6')) return true; // an IPv4 address written as IPv6 is checked as IPv4
  const inside = carried(ip);
  return !!inside && LOCAL.check(inside, 'ipv4');
};
// For the tests only: the stand-ins' own host:port (comma-separated), which are on 127.0.0.1.
const stubs = () => (testing('LOUI_FEEDS_LOCAL') || '').split(',').filter(Boolean);

// The address as a URL if it is http(s) and on the open web, and the
// addresses its name stands for; throws if not. The name is looked up first,
// so a public name for a private address is refused as well. (found is null
// for a test's stand-in, which is not looked up.)
async function web(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('not a web address'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('not a web address');
  if (stubs().includes(u.host)) return { u, found: null };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const found = /(^|\.)localhost\.?$/i.test(host) ? [] : net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await dns.promises.lookup(host, { all: true });
  if (!found.length || found.some((a) => local(a.address))) throw new Error('an address on this machine or its network');
  return { u, found };
}

// The answer's head for a GET of u. The connection is made to the addresses
// that were checked (found), not to whatever the name answers when asked a
// second time: a name can say a public address once and 127.0.0.1 next. So
// this is Node's http and not fetch, which looks every name up itself.
function ask(u, found, signal) {
  const lookup = found && ((host, options, done) => (options.all ? done(null, found) : done(null, found[0].address, found[0].family)));
  return new Promise((done, failed) => {
    (u.protocol === 'https:' ? https : http).get(u, {
      signal, agent: false, ...(lookup && { lookup }),
      headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'node' }, // what fetch said it was
    }, done).on('error', failed);
  });
}
const UNPACK = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

// The body of an http(s) address as text: within TIMEOUT_MS, and MAX_BYTES at
// most. Redirects are followed by hand, REDIRECTS at most, each one checked
// like the first address.
const REDIRECTS = 5;
async function get(url) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  for (let hops = 0; ; hops++) {
    const { u, found } = await web(url);
    res = await ask(u, found, signal);
    const to = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (!to) break;
    res.destroy();
    if (hops >= REDIRECTS) throw new Error('too many redirects');
    url = new URL(to, u).href;
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.destroy();
    throw new Error(`status ${res.statusCode}`);
  }
  const unpack = UNPACK[String(res.headers['content-encoding'] || '').trim().toLowerCase()];
  const body = unpack ? pipeline(res, unpack(), () => {}) : res;
  const parts = [];
  let size = 0;
  try {
    for await (const part of body) {
      size += part.length;
      if (size > MAX_BYTES) break;
      parts.push(part);
    }
  } finally {
    res.destroy();
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
  // Unless chosen: by the system's region (not the language Loui's menus are in).
  const units = () => {
    if (['c', 'f'].includes(settings.weatherUnits)) return settings.weatherUnits;
    let country = '';
    try { country = app.getLocaleCountryCode() || /[-_]([A-Za-z]{2})\b/.exec(app.getSystemLocale())?.[1] || ''; } catch {}
    return FAHRENHEIT.includes(country.toUpperCase()) ? 'f' : 'c';
  };
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

  // The last reading that was had, kept so that a fetch that fails (or other
  // units asked for while the service is down) still has something to show.
  let last = null; // { where, units, at, place, now, sky, high, low }
  const inUnits = (v, from, to) => (from === to ? v : Math.round(to === 'f' ? v * 9 / 5 + 32 : (v - 32) * 5 / 9));
  async function weatherNow() {
    const p = place();
    if (!p) return null;
    const where = `${p.lat},${p.lon}`, u = units();
    const w = await weather.get(`${where},${u}`);
    if (w && !w.failed) {
      if (last?.from !== w) last = { ...w, from: w, where, units: u, at: Date.now() }; // the same answer, still kept: read when it was
      return w;
    }
    if (last?.where !== where) return w;
    const { now, high, low } = last;
    return { failed: true, place: last.place, sky: last.sky, at: last.at, now: inUnits(now, last.units, u), high: inUnits(high, last.units, u), low: inUnits(low, last.units, u) };
  }

  // The places a name could mean, best first: [{ name (as the start page says
  // it), full ("Mendoza, Mendoza, Argentina"), lat, lon }]. null: the lookup failed.
  let matches = null; // { text, list }: what the name last typed in Settings could mean
  async function lookUp(text) {
    if (matches?.text === text) return matches.list;
    let results;
    try {
      const q = new URLSearchParams({ name: text, count: PLACES, language: 'en', format: 'json' });
      results = JSON.parse(await get(`${GEOCODE()}?${q}`)).results;
    } catch { return null; }
    const list = (Array.isArray(results) ? results : []).filter((r) => r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)).slice(0, PLACES).map((r) => ({
      name: [...new Set([r.name, r.country_code === 'US' ? r.admin1 : r.country].filter(Boolean))].join(', ').slice(0, 80),
      full: [r.name, r.admin1, r.country].filter((x) => typeof x === 'string' && x).join(', ').slice(0, 120),
      lat: r.latitude, lon: r.longitude,
    }));
    matches = { text, list };
    return list;
  }
  const keep = (text, m) => {
    settings.weatherPlace = text;
    settings.weatherAt = { name: m.name, lat: m.lat, lon: m.lon, full: m.full };
    save();
  };
  let trouble = ''; // why the feed last offered in Settings was not added

  return {
    units, feeds,
    place: () => place()?.name || '',
    // For Settings: the place as it was resolved, and what else its name could mean (once asked).
    resolved: () => (place() ? (typeof place().full === 'string' && place().full) || place().name : ''),
    others: () => (matches && place() && matches.text === settings.weatherPlace
      ? matches.list.filter((m) => m.lat !== place().lat || m.lon !== place().lon).map((m) => ({ full: m.full, lat: m.lat, lon: m.lon })) : null),
    known: () => KNOWN_FEEDS.filter((k) => !feeds().includes(k.url)),
    trouble: () => trouble,
    // For a start page being served: null when there is no place yet, { failed } when it could not be
    // had ({ failed, now, …, at } with the last reading, if there was one).
    // kept: only what is already here, with no fetch (a private window's start page).
    weather: (kept = false) => (kept ? (place() ? weather.peek(`${place().lat},${place().lon},${units()}`) : null) : weatherNow()),
    // "Try again": the next start page asks afresh.
    retry() { weather.forget(); },
    news: (kept = false) => (!feeds().length ? Promise.resolve(null) : news[kept ? 'peek' : 'get'](feeds().join('\n'))),
    // A place name as typed -> its coordinates, kept: the best match of that
    // name. False if no such place was found.
    async setPlace(name) {
      const text = String(name || '').trim().slice(0, 100);
      if (!text) {
        delete settings.weatherPlace;
        delete settings.weatherAt;
        matches = null;
        save();
        return true;
      }
      const list = await lookUp(text);
      if (!list?.length) return false;
      keep(text, list[0]);
      return true;
    },
    // "Not this one?": what else the place's name could mean, for others().
    async otherPlaces() {
      if (typeof settings.weatherPlace === 'string' && place()) await lookUp(settings.weatherPlace);
    },
    // One of others(), chosen.
    choosePlace({ lat, lon } = {}) {
      const m = matches?.text === settings.weatherPlace && matches.list.find((x) => x.lat === lat && x.lon === lon);
      if (m) keep(matches.text, m);
    },
    setUnits(u) {
      if (!['c', 'f'].includes(u)) return;
      settings.weatherUnits = u;
      save();
    },
    // Fetched once before it is listed: an address with no headlines at it is
    // not kept (trouble() says why).
    async addFeed(url) {
      const text = String(url || '').trim();
      let u;
      try { u = new URL(text); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) { trouble = 'That is not a web address.'; return; }
      if (feeds().includes(u.href)) { trouble = 'That feed is already listed.'; return; }
      let items = [];
      try { items = parseFeed(await get(u.href), u.href); } catch {}
      if (!items.length) { trouble = 'No headlines found at that address.'; return; }
      trouble = '';
      settings.newsFeeds = [...feeds(), u.href];
      save();
    },
    removeFeed(url) {
      settings.newsFeeds = feeds().filter((f) => f !== url);
      save();
    },
  };
}

module.exports = { createFeeds, parseFeed, get, local, KNOWN_FEEDS, DEFAULT_FEEDS };
