// The few things in Loui that depend on other people's servers, checked
// against the real ones. Nothing else in the tests touches the network, so
// this file runs on its own: nightly and by hand (.github/workflows/
// integration.yml, `npm run test:live`), never on a pull request. A site
// changing is not a broken commit.
//
//   Google's sign-in still accepts Loui as the browser it says it is (identity.js)
//   Shields' filter lists still download and build into an engine that blocks (shields.js)
//   the start page's default news feed still downloads and parses (startfeeds.js)
//
// With LOUI_LIVE_REPORT set, how each check went is also written there as
// JSON; report-live.js turns the failures into GitHub issues.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { adsAndTrackingLists } = require('@ghostery/adblocker');
const { launch } = require('../drive');
const { RESOURCES } = require('../../src/main/shields');
const { DEFAULT_FEEDS } = require('../../src/main/startfeeds');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const got = await check();
    if (got) return got;
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A check, by the title its issue would have.
const results = [];
function live(id, title, fn) {
  test(title, async () => {
    try {
      await fn();
      results.push({ id, title, ok: true });
    } catch (e) {
      results.push({ id, title, ok: false, detail: String(e?.message || e).slice(0, 4000) });
      throw e;
    }
  });
}

let b, pages, home;
test.before(async () => {
  // A page of our own that asks for two things every ad list blocks.
  pages = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Ads</title><h1>A page with ads</h1>'
      + '<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>'
      + '<img src="https://www.google-analytics.com/collect?v=1&t=pageview" alt="">');
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-live-'));
  // The start page and its news as the user has them (the tests' default is a blank tab and no feed).
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ newTab: 'start', newsFeeds: DEFAULT_FEEDS }));
  // The real lists: under LOUI_TEST Shields downloads none unless it is given them.
  b = await launch({ LOUI_SHIELDS_LISTS: adsAndTrackingLists.join(',') }, { home });
});
test.after(async () => {
  await b?.close();
  pages?.close();
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  if (process.env.LOUI_LIVE_REPORT) fs.writeFileSync(process.env.LOUI_LIVE_REPORT, JSON.stringify(results, null, 2));
});

live('google-sign-in', 'Google\'s sign-in accepts Loui', async () => {
  // A made-up address: "Couldn't find this account" means Google looked it
  // up, so the browser was let through; a browser it refuses is sent to
  // /v3/signin/rejected ("This browser or app may not be secure") instead.
  const s = b.as('google', 'Live check');
  const page = await s.text('navigate', { url: 'https://accounts.google.com/?hl=en' });
  const ref = (re) => {
    const m = page.match(re);
    assert.ok(m, `the sign-in page is not as expected:\n${page.slice(0, 1500)}`);
    return m[1];
  };
  await s.text('type', { ref: ref(/textbox "Email or phone" \[(e\d+)\]/), text: `loui-live-check-${Date.now()}@gmail.com` });
  // The guardrails ask before a session submits a sign-in form; the user says yes.
  const clicked = s.text('click', { ref: ref(/button "Next" \[(e\d+)\]/) });
  const asked = await until('the guardrail question', async () => (await b.state()).guard);
  await b.ui('guard:answer', { id: asked.id, choice: 'once' });
  await clicked;
  let seen = '';
  await until('Google to answer', async () => {
    seen = await s.text('snapshot');
    assert.doesNotMatch(seen, /signin\/rejected|may not be secure/, `Google refused Loui as a browser:\n${seen.slice(0, 1500)}`);
    return /Couldn.t find (this|your Google) account/i.test(seen);
  }, 30000).catch((e) => { throw new Error(`${e.message}\nThe page last read:\n${seen.slice(0, 1500)}`); });
  s.end();
});

live('shields-lists', 'Shields\' filter lists download and block', async () => {
  // The stand-in scripts are fetched beside the lists in a normal run (not with lists given by hand).
  const res = await fetch(RESOURCES, { signal: AbortSignal.timeout(60000) });
  assert.equal(res.status, 200, RESOURCES);
  assert.ok(Object.keys(JSON.parse(await res.text())).length > 0, 'the stand-in scripts parse');

  const engine = path.join(home, 'shields', 'engine.bin');
  await until(`the ${adsAndTrackingLists.length} lists to download and build`, () => fs.existsSync(engine), 120000);
  assert.ok(fs.statSync(engine).size > 500 * 1024, `the engine is ${fs.statSync(engine).size} bytes`);
  const url = `http://127.0.0.1:${pages.address().port}/`;
  await b.ui('go', url);
  const s = await until('requests to ad servers to be blocked', async () => {
    const now = (await b.state()).shields;
    return now?.ready && now.blocked >= 2 && now;
  }, 30000);
  assert.equal(s.on, true);
});

live('start-page-news', 'The start page\'s news feed downloads and parses', async () => {
  const before = (await b.state()).tabs.find((t) => t.active).id;
  await b.ui('tab:new', '');
  const js = (id, code) => b.ui('tab:js', { id, code }).catch(() => null);
  const tab = await until('the start page', async () => {
    const t = (await b.state()).tabs.find((x) => x.active);
    return t.id !== before && !t.loading && (await js(t.id, 'location.protocol')) === 'loui-start:' && t;
  });
  // The page waits a moment for the news; a page drawn before it arrived is drawn again when asked.
  const news = await until('headlines', async () => {
    const got = await js(tab.id, `[...document.querySelectorAll('.news a')].map((a) => ({ href: a.href, text: a.textContent.trim() }))`);
    if (got?.length) return got;
    await b.ui('reload');
    await sleep(1500);
    return null;
  }, 40000).catch(async (e) => {
    throw new Error(`${e.message}. Feeds: ${DEFAULT_FEEDS.join(', ')}. The page says: ${String(await js(tab.id, "document.querySelector('.news')?.innerText")).slice(0, 300)}`);
  });
  assert.ok(news.length >= 3, `${news.length} headlines`);
  for (const n of news) {
    assert.match(n.href, /^https?:\/\//);
    assert.ok(n.text.length > 5, JSON.stringify(n));
  }
});
