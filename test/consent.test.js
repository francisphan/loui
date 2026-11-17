// Asking before a new Claude session first uses the browser (consent.js), and
// questions from several sessions waiting their turn in the helm (prompts.js).
// Sessions here opt in to being asked with { ask: true }, as sessions from the
// relay always are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (what, check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const asked = (who) => wait(`a question from ${who}`, async () => {
  const p = (await b.state()).prompt;
  return p?.who === who && p;
});
const answer = (p, value) => b.ui('prompt:answer', { id: p.id, value });
const groupIds = async () => (await b.state()).groups.map((g) => g.id).filter((id) => id !== 'you');
const DESKTOP = { id: 'connector-desktop-1', name: 'Claude', kind: 'connector' };
const OTHER = { id: 'connector-other-22', name: 'Claude', kind: 'connector' };

test('a new session is asked about; until allowed it has no group, then its call goes ahead', async () => {
  const s = b.as('c1', 'Claude Desktop', { ask: true, connector: DESKTOP });
  const call = s.text('navigate', { url: b.base });
  const p = await asked('Claude Desktop');
  assert.equal(p.kind, 'consent');
  assert.deepEqual(p.connector, DESKTOP);
  assert.deepEqual(await groupIds(), [], 'no group while the user is asked');
  await answer(p, 'allow');
  assert.match(await call, /Fixture page/);
  assert.deepEqual(await groupIds(), ['c1']);
  assert.match(await s.text('snapshot'), /Fixture page/, 'asked once per session');
  assert.equal((await b.state()).prompt, null);
  s.end();
});

test('a denied session gets a clear refusal and no group, and is not asked again', async () => {
  const s = b.as('c2', 'Claude Code · pung', { ask: true, connector: DESKTOP });
  const call = s.text('navigate', { url: b.base });
  await answer(await asked('Claude Code · pung'), 'deny');
  await assert.rejects(call, /did not allow this session to use their browser/);
  assert.deepEqual(await groupIds(), []);
  await assert.rejects(s.text('snapshot'), /did not allow/);
  assert.equal((await b.state()).prompt, null, 'refused without asking again');
  s.end();
});

test('sessions on the local socket that do not opt in are not asked', async () => {
  const s = b.as('local-1', 'Local');
  assert.match(await s.text('navigate', { url: b.base }), /Fixture page/);
  s.end();
});

test('"always allow" lets the next session from that connector in, not others, until revoked', async () => {
  const one = b.as('c3', 'Claude', { ask: true, connector: DESKTOP });
  const call = one.text('navigate', { url: b.base });
  await answer(await asked('Claude'), 'always');
  await call;
  one.end();
  assert.deepEqual((await b.state()).allowedConnectors.map((c) => c.id), [DESKTOP.id]);
  const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'consent.json'), 'utf8'));
  assert.ok(saved.connectors[DESKTOP.id], 'kept in consent.json');

  const two = b.as('c4', 'Claude 2', { ask: true, connector: DESKTOP });
  assert.match(await two.text('navigate', { url: b.base }), /Fixture page/, 'let in without asking');
  two.end();

  const other = b.as('c5', 'Other', { ask: true, connector: OTHER });
  const otherCall = other.text('navigate', { url: b.base });
  await answer(await asked('Other'), 'allow');
  await otherCall;
  other.end();

  await b.ui('consent:revoke', DESKTOP.id);
  assert.deepEqual((await b.state()).allowedConnectors, []);
  const three = b.as('c6', 'Claude 3', { ask: true, connector: DESKTOP });
  const threeCall = three.text('navigate', { url: b.base });
  await answer(await asked('Claude 3'), 'allow');
  await threeCall;
  three.end();
});

test('new sessions asking at once are shown one at a time, with a count, in order', async () => {
  const one = b.as('q1', 'First', { ask: true });
  const two = b.as('q2', 'Second', { ask: true });
  const three = b.as('q3', 'Third', { ask: true });
  const calls = [one, two, three].map((s) => s.text('navigate', { url: b.base }).catch((e) => e.message));
  const first = await asked('First');
  assert.equal(first.connector, null, 'no connector, so no "always allow"');
  assert.deepEqual((await b.state()).waiting, ['Second', 'Third']);

  // A session that ends while waiting takes its question with it.
  two.end();
  await wait('the second question to go', async () => (await b.state()).waiting.length === 1);
  assert.match(await calls[1], /did not answer/);

  await answer(first, 'allow');
  assert.match(await calls[0], /Fixture page/);
  await answer(await asked('Third'), 'deny');
  assert.match(await calls[2], /did not allow/);
  assert.deepEqual(await groupIds(), ['q1']);
  one.end();
  three.end();
  await sleep(300);
});

test('two sessions asking for a tab are answered in turn, each named', async () => {
  const a = b.as('h1', 'Claude Code · one');
  const c = b.as('h2', 'Claude Code · two');
  await a.text('navigate', { url: b.base });
  await c.text('navigate', { url: b.base });
  const mine = (await b.state()).tabs.find((t) => t.active);
  assert.equal(mine.group, 'you');

  const askA = a.text('request_tab');
  const askC = c.text('request_tab');
  const p = await asked('Claude Code · one');
  assert.equal(p.kind, 'handoff');
  assert.deepEqual((await b.state()).waiting, ['Claude Code · two'], 'the second waits instead of failing');
  await answer(p, false);
  assert.match(await askA, /did not hand over/);

  const q = await asked('Claude Code · two');
  await answer(q, true);
  assert.match(await askC, new RegExp(`handed you tab ${mine.id}`));
  a.end();
  c.end();
  await sleep(300);
});

test("a session that ends takes its waiting hand-over question with it", async () => {
  const a = b.as('h3', 'Asks first');
  const c = b.as('h4', 'Asks second');
  await a.text('navigate', { url: b.base });
  await c.text('navigate', { url: b.base });
  const askA = a.text('request_tab');
  const askC = c.text('request_tab');
  await asked('Asks first');
  c.end();
  assert.match(await askC, /did not hand over/);
  assert.deepEqual((await b.state()).waiting, []);
  a.end();
  assert.match(await askA, /did not hand over/);
  await wait('the helm to clear', async () => (await b.state()).prompt === null);
});

test('two sessions asking the user to point wait their turn instead of cancelling each other', async () => {
  const a = b.as('p1', 'Points first');
  const c = b.as('p2', 'Points second');
  await a.text('navigate', { url: b.base });
  await c.text('navigate', { url: b.base + '/second.html' });
  const pickA = a.text('ask_user_to_pick', { message: 'Which card?' });
  const pickC = c.text('ask_user_to_pick', { message: 'Which heading?' });
  const p = await asked('Points first');
  assert.equal(p.kind, 'pick');
  assert.equal(p.message, 'Which card?');
  let s = await b.state();
  assert.ok(s.picking.active);
  assert.equal(s.tabs.find((t) => t.active).group, 'p1', "the first session's tab is on screen");
  assert.deepEqual(s.waiting, ['Points second']);

  await b.ui('pick:cancel');
  assert.match(await pickA, /did not pick anything/);
  await asked('Points second');
  s = await b.state();
  assert.ok(s.picking.active, "the second session's pick has started");
  assert.equal(s.tabs.find((t) => t.active).group, 'p2');
  c.end();
  assert.match(await pickC, /did not pick anything/);
  await wait('pointing to stop', async () => !(await b.state()).picking.active);
  a.end();
});

test('"1 more" in the helm shows the next question, so a waiting one can be answered first', async () => {
  const chrome = (code) => b.ui('chrome:eval', code);
  const a = b.as('n1', 'Wants a tab');
  await a.text('navigate', { url: b.base });
  assert.equal((await b.state()).tabs.find((t) => t.active).group, 'you');
  const tabAsk = a.text('request_tab');
  const first = await asked('Wants a tab');
  const c = b.as('n2', 'Newcomer', { ask: true });
  const call = c.text('navigate', { url: b.base }).catch((e) => e.message);
  await wait('the newcomer to wait', async () => (await b.state()).waiting.length === 1);
  await wait('the count', async () => (await chrome("document.getElementById('helm-more').textContent")) === '1 more');
  await chrome("document.getElementById('helm-more').click()");
  const second = await asked('Newcomer');
  assert.equal(second.kind, 'consent');
  assert.deepEqual((await b.state()).waiting, ['Wants a tab'], 'the first went to the back of the line');
  await wait('the question in the helm', async () => (await chrome("document.getElementById('helm-text').textContent")) === 'Let Newcomer use Loui?');
  await answer(second, 'allow');
  assert.match(await call, /Fixture page/);
  // The one set aside is still asked, and still answerable.
  const again = await asked('Wants a tab');
  assert.equal(again.id, first.id);
  await answer(again, false);
  assert.match(await tabAsk, /did not hand over/);
  a.end();
  c.end();
  await sleep(300);
});

test('a pointing question set aside for the next one is asked again, not cancelled', async () => {
  const a = b.as('n3', 'Pointer');
  const c = b.as('n4', 'Borrower');
  await a.text('navigate', { url: b.base });
  await c.text('navigate', { url: b.base + '/second.html' });
  const pick = a.text('ask_user_to_pick', { message: 'Which card?' });
  await asked('Pointer');
  await wait('pointing to start', async () => (await b.state()).picking.active);
  const tabAsk = c.text('request_tab');
  await wait('the second to wait', async () => (await b.state()).waiting.length === 1);
  await b.ui('prompt:next');
  const q = await asked('Borrower');
  assert.equal((await b.state()).picking.active, false, 'pointing stops while the other question is on show');
  await answer(q, false);
  assert.match(await tabAsk, /did not hand over/);
  await asked('Pointer');
  await wait('pointing to start again', async () => (await b.state()).picking.active);
  await b.ui('pick:cancel');
  assert.match(await pick, /did not pick anything/);
  a.end();
  c.end();
});
