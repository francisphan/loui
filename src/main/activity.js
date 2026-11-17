// Activity log: what each Claude session did, kept after it has gone. When a
// session ends its tab group closes, so this is the only record of which
// pages it opened and what it clicked or typed there.
//
// Every tool call passes through sessions.during(), which asks this module for
// a step: the plain-language label shown in the window, the tab's page when it
// finished, whether it worked and, for steps that act on the page, a small
// picture of the tab afterwards. Guardrails questions and the user letting a
// session in (or not) are steps too.
//
// One JSON file per session in activity/ in the profile, its pictures in a
// folder of the same name. Kept settings.activityDays days (default 7; 0 keeps
// nothing and records nothing), and at most settings.activityMaxMB in all
// (default 200), oldest first.
//
// Privacy: no tool reads this (the window chrome alone asks for it). Text typed
// into password, card and one-time-code fields is stored as its length only,
// other typed text up to 200 characters, and only the first line of a script.
// Tabs of a private window are not recorded.
//
// On disk the logs and pictures are encrypted where the system can encrypt
// (cipher: as passwords.js makes it): with a key of their own, kept beside
// the folder (activity.key) encrypted by the system. Where it cannot, they
// are plain files only this user can read.
//
// The Claude panel works in the user's own tabs and has no session that ends:
// its steps go to one "Claude panel" log per day.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DAY = 864e5;
const THUMB_WIDTH = 320;
const MAX_STEPS = 2000; // a runaway session stops growing its log here
const TEXT_MAX = 200;

const clip = (s, n = TEXT_MAX) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const slug = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 40);
const dayOf = (t) => new Date(t).toDateString();
// Private windows (being built alongside this) mark their tabs; nothing in
// them is recorded. Until then no tab has the field and this is always false.
const MAGIC = Buffer.from('LOUIA1'); // starts an encrypted file

// seal(bytes) / open(bytes): AES-256-GCM under the log's own key. A file
// without the mark is read as it is (written before logs were encrypted, or
// where the system cannot encrypt); one that will not open throws.
const sealed = (b) => b.subarray(0, MAGIC.length).equals(MAGIC);
const PLAIN = {
  on: false,
  seal: (b) => b,
  open(b) { if (sealed(b)) throw new Error('encrypted'); return b; },
};

function createBox(cipher, keyFile) {
  if (!cipher?.available) return PLAIN;
  let key = null;
  try {
    let kept = null;
    try { kept = fs.readFileSync(keyFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (kept !== null) {
      try { key = Buffer.from(cipher.decrypt(kept), 'base64'); } catch {}
      if (key?.length !== 32) {
        // From another machine or account, or the system's own key is not
        // what it was. It is never written over: put aside, it can be put
        // back should the system open it again. Logs under it stay until
        // they are too old (see load()).
        key = null;
        fs.renameSync(keyFile, `${keyFile}.bad-${Date.now()}`);
      }
    }
    if (!key) {
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, cipher.encrypt(key.toString('base64')), { mode: 0o600, flag: 'wx' });
    }
  } catch {
    // The keyring failed or the profile cannot be written: plain files for
    // this run, and whatever key file there is stays as it is.
    return PLAIN;
  }
  return {
    on: true,
    seal(bytes) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(bytes), c.final()]);
      return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
    },
    open(bytes) {
      if (!sealed(bytes)) return bytes;
      const at = MAGIC.length;
      const d = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(at, at + 12));
      d.setAuthTag(bytes.subarray(at + 12, at + 28));
      return Buffer.concat([d.update(bytes.subarray(at + 28)), d.final()]);
    },
  };
}

const isPrivate = (tab) => !!(tab && (tab.private || tab.partition?.startsWith?.('private')));

function createActivity({ dir, tabs, settings, save, changed = () => {}, cipher }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const box = createBox(cipher, `${dir}.key`);
  const pack = (data) => box.seal(Buffer.from(JSON.stringify(data)));
  const keepDays = () => (Number.isFinite(settings.activityDays) ? Math.max(0, settings.activityDays) : 7);
  const maxBytes = () => (Number.isFinite(settings.activityMaxMB) ? settings.activityMaxMB : 200) * 1048576;

  // A log: { data, off, saving, timer }. data is what is written to disk;
  // off: deleted by the user, so nothing more is written for it.
  const live = new Map(); // session id ('panel' for the Claude panel) -> log
  const index = new Map(); // log id -> summary, for every log on disk or live
  const capturing = new Set(); // tab ids with a picture being taken
  const waiting = new Map(); // tab id -> the latest step to picture once that one is done
  const welcome = new Map(); // session id -> the user's consent, a step for when its log opens
  const file = (id) => path.join(dir, `${id}.json`);
  const pictures = (id) => path.join(dir, id);

  const summary = (d) => ({
    id: d.id, label: d.label, source: d.source, connector: d.connector || null,
    start: d.start, end: d.end, ended: d.ended,
    steps: d.steps.filter((s) => s.kind === 'tool').length,
    failed: d.steps.filter((s) => s.error).length,
  });
  const lastTime = (d) => d.steps.reduce((t, s) => Math.max(t, s.at + (s.ms || 0)), d.start);

  // The window is told at most twice a second, and which logs changed (no
  // ids: the settings did), so it only fetches again the one it is showing.
  let telling = null;
  let told = new Set();
  const tell = (id) => {
    if (id && told) told.add(id);
    else told = null;
    telling ||= setTimeout(() => {
      const ids = told ? [...told] : undefined;
      telling = null;
      told = new Set();
      changed(ids);
    }, 500);
  };

  // Saves still on their way, by session id. A session's last save can still be
  // running after its log has stopped being live, so removing a session waits
  // for it here, and a removed session's late save is dropped (else "Clear
  // all" could delete a file that the save then wrote back).
  const saving = new Map();
  const removed = new Set();
  function write(log) {
    const id = log.data.id;
    log.saving = (log.saving || Promise.resolve()).then(async () => {
      if (log.off || removed.has(id)) return;
      const to = file(id);
      await fsp.writeFile(`${to}.tmp`, pack(log.data), { mode: 0o600 });
      if (removed.has(id)) return void fsp.rm(`${to}.tmp`, { force: true }).catch(() => {});
      await fsp.rename(`${to}.tmp`, to);
    }).catch(() => {});
    saving.set(id, log.saving);
    log.saving.then(() => { if (saving.get(id) === log.saving) saving.delete(id); });
    return log.saving;
  }
  // Writes are bunched: a busy session takes several steps a second.
  function dirty(log) {
    if (log.off) return; // removed: a late picture must not bring it back
    index.set(log.data.id, summary(log.data));
    tell(log.data.id);
    if (log.timer || log.off) return;
    log.timer = setTimeout(() => { log.timer = null; write(log); }, 1000);
  }

  function newLog(data) {
    const log = { data, off: false, saving: null, timer: null };
    removed.delete(data.id); // a session id seen again starts a log afresh
    dirty(log);
    return log;
  }

  // ── what sessions.js tells this ─────────────────────────────────────────
  // A session's first tool call. request: the session as it arrived, with the
  // connector the relay names (consent.js).
  function open(session, request = {}) {
    const said = welcome.get(session.id);
    welcome.delete(session.id);
    if (!keepDays() || live.has(session.id)) return;
    const start = Date.now();
    const connector = typeof request.connector?.name === 'string' ? clip(request.connector.name, 48) : null;
    live.set(session.id, newLog({
      id: `${start}-${slug(session.id)}`, session: session.id, label: session.label, source: session.source,
      connector, start, end: null, ended: null, steps: said ? [said] : [],
    }));
  }

  // how: 'ended' (the session said so, or its connection closed), 'closed'
  // (the user closed its tab group) or 'lost' (the relay went away).
  function end(id, how = 'ended') {
    const log = live.get(id);
    welcome.delete(id);
    if (!log || id === 'panel') return;
    live.delete(id);
    clearTimeout(log.timer);
    log.timer = null;
    log.data.end = Date.now();
    log.data.ended = how;
    index.set(log.data.id, summary(log.data));
    tell(log.data.id);
    write(log).then(prune);
  }

  // The panel's log for today, started (or carried on from earlier today) on its first step.
  function panelLog() {
    let log = live.get('panel');
    if (log && dayOf(log.data.start) === dayOf(Date.now())) return log;
    if (log) {
      log.data.end = lastTime(log.data);
      log.data.ended = 'day';
      dirty(log);
    }
    const start = Date.now();
    log = newLog({
      id: `${start}-panel`, session: 'panel', label: 'Claude panel', source: 'panel',
      connector: null, start, end: null, ended: null, steps: [],
    });
    live.set('panel', log);
    return log;
  }

  // One tool call, from sessions.during(). Returns a handle the call reports
  // through, or null when nothing is recorded. Only pushes a record: the
  // picture is taken once the call has returned.
  function step(session, label, acts) {
    if (!keepDays() || isPrivate(tabs.current(session.group))) return null;
    const log = session.source === 'panel' ? panelLog() : live.get(session.id);
    if (!log || log.off || log.data.steps.length >= MAX_STEPS) return null;
    const s = { kind: 'tool', at: Date.now(), label };
    log.data.steps.push(s);
    dirty(log);
    return {
      label(text) { s.label = text; },
      // What was typed or run, already made safe by actions.js; clipped here too.
      note(detail) { if (typeof detail === 'string' && detail) s.detail = clip(detail.split('\n')[0]); },
      done(error) {
        s.ms = Date.now() - s.at;
        if (error) s.error = clip(String(error.message || error).split('\n')[0], 300);
        const tab = tabs.current(session.group);
        if (tab && !isPrivate(tab)) {
          s.url = tab.url;
          s.title = clip(tab.title || '', 120);
        }
        dirty(log);
        if (acts && tab && !isPrivate(tab)) setImmediate(() => snap(log, s, tab));
      },
    };
  }

  // A small picture of the tab after an acting step. At most one per tab at a
  // time: a step that finishes while one is being taken waits for it (only the
  // latest such step; on a slow machine the ones between get none). A sleeping
  // tab (no page) or a closed one is skipped.
  async function snap(log, s, tab) {
    const wc = tab.wc;
    if (capturing.has(tab.id)) return void waiting.set(tab.id, { log, s, tab });
    if (log.off || !wc || wc.isDestroyed()) return;
    capturing.add(tab.id);
    try {
      // A tab out of sight may not be drawn (always so without a GPU), so it
      // peeks, as for the screenshot tool, and is pictured once it has drawn
      // a frame. Without a GPU the first capture can still fail; one retry.
      tabs.use(tab);
      const drawn = () => wc.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true);
      await Promise.race([drawn(), new Promise((r) => setTimeout(r, 1000))]);
      const img = await wc.capturePage().catch(async () => {
        await new Promise((r) => setTimeout(r, 300));
        if (wc.isDestroyed()) throw new Error('the tab closed');
        tabs.use(tab);
        await Promise.race([drawn(), new Promise((r) => setTimeout(r, 1000))]);
        return wc.capturePage();
      });
      const { width } = img.getSize();
      if (!width && process.env.LOUI_TEST) console.error('activity: no picture: the capture was empty');
      if (!width || log.off) return;
      const jpeg = img.resize({ width: Math.min(THUMB_WIDTH, width), quality: 'good' }).toJPEG(60);
      const name = `${log.data.steps.indexOf(s)}.jpg`;
      await fsp.mkdir(pictures(log.data.id), { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(pictures(log.data.id), name), box.seal(jpeg));
      if (log.off) return void fsp.rm(pictures(log.data.id), { recursive: true, force: true }).catch(() => {});
      s.thumb = name;
      dirty(log);
    } catch (e) {
      // The tab closed or could not be drawn: the step simply has no picture.
      if (process.env.LOUI_TEST) console.error('activity: no picture:', e?.message || e);
    } finally {
      capturing.delete(tab.id);
      const next = waiting.get(tab.id);
      if (next) {
        waiting.delete(tab.id);
        snap(next.log, next.s, next.tab);
      }
    }
  }

  // The user let a session in, or did not (consent.js). A session turned
  // away never gets a log of its own otherwise, so it gets one here.
  function consent(session, choice) {
    if (!keepDays()) return;
    const label = {
      allow: 'You let it use Loui',
      always: 'You let it use Loui, and always let this connector in',
      deny: 'You did not let it use Loui',
    }[choice];
    if (!label) return; // not answered: it will be asked again
    const s = { kind: 'consent', at: Date.now(), label };
    if (choice !== 'deny') return void welcome.set(session.id, s);
    open(session, session);
    const log = live.get(session.id);
    if (log) log.data.steps.push(s);
    end(session.id, 'refused');
  }

  // A guardrails question (guardrails.js) and the user's answer.
  function guard(session, { what, site, ok, timedOut }) {
    const log = session.source === 'panel' ? live.get('panel') : live.get(session.id);
    if (!log || log.off) return;
    const answer = ok ? 'you allowed it' : timedOut ? 'no answer, so it was stopped' : 'you blocked it';
    log.data.steps.push({ kind: 'guard', at: Date.now(), label: `Asked before it would ${what} on ${site}: ${answer}`, error: ok ? undefined : answer });
    dirty(log);
  }

  // ── on disk ─────────────────────────────────────────────────────────────
  async function read(id) {
    try { return JSON.parse(box.open(await fsp.readFile(file(id))).toString('utf8')); } catch { return null; }
  }

  async function sizeOf(id) {
    let bytes = 0;
    try { bytes += (await fsp.stat(file(id))).size; } catch {}
    try {
      for (const f of await fsp.readdir(pictures(id))) {
        try { bytes += (await fsp.stat(path.join(pictures(id), f))).size; } catch {}
      }
    } catch {}
    return bytes;
  }

  async function remove(id) {
    removed.add(id);
    for (const [key, log] of live) {
      if (log.data.id !== id) continue;
      log.off = true;
      clearTimeout(log.timer);
      live.delete(key);
      await log.saving;
    }
    await saving.get(id); // a save that outlived the live log
    await fsp.rm(file(id), { force: true }).catch(() => {});
    await fsp.rm(pictures(id), { recursive: true, force: true }).catch(() => {});
    index.delete(id); // off the list once its files are gone
    tell(id);
  }

  // Older than the setting, then the oldest until all of it fits the cap.
  // Logs still being written are left alone.
  let pruning = Promise.resolve();
  function prune() {
    pruning = pruning.then(async () => {
      const busy = new Set([...live.values()].map((l) => l.data.id));
      const days = keepDays();
      const old = [...index.values()].filter((s) => !busy.has(s.id))
        .sort((a, b) => (a.end || a.start) - (b.end || b.start));
      const kept = [];
      for (const s of old) {
        if (!days || Date.now() - (s.end || s.start) > days * DAY) await remove(s.id);
        else kept.push(s);
      }
      let total = 0;
      const sizes = new Map();
      for (const s of index.values()) {
        const bytes = await sizeOf(s.id);
        sizes.set(s.id, bytes);
        total += bytes;
      }
      for (const s of kept) {
        if (total <= maxBytes()) break;
        total -= sizes.get(s.id) || 0;
        await remove(s.id);
      }
    }).catch(() => {});
    return pruning;
  }

  // A log written as plain files (before logs were encrypted) is encrypted
  // where it lies.
  async function encryptOld(id) {
    if (!box.on) return;
    const redo = async (f) => {
      // Only the mark is read: most files are encrypted already.
      const fh = await fsp.open(f, 'r');
      let head;
      try { head = (await fh.read(Buffer.alloc(MAGIC.length), 0, MAGIC.length, 0)).buffer; } finally { await fh.close(); }
      if (sealed(head)) return;
      const bytes = await fsp.readFile(f);
      await fsp.writeFile(`${f}.tmp`, box.seal(bytes), { mode: 0o600 });
      await fsp.rename(`${f}.tmp`, f);
    };
    await redo(file(id)).catch(() => {});
    for (const f of await fsp.readdir(pictures(id)).catch(() => [])) {
      if (!f.endsWith('.tmp')) await redo(path.join(pictures(id), f)).catch(() => {});
    }
  }

  // At start: every log on disk is listed. One left unfinished was cut short
  // by Loui closing; the panel's log for today carries on.
  async function load() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await fsp.readdir(dir)) {
      if (name.endsWith('.tmp')) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const data = await read(id);
      if (!data?.id || !Array.isArray(data.steps)) {
        // Encrypted under a key that is gone or cannot be reached in this
        // run, or damaged. It is not deleted here (the key may come back),
        // but listed by the file's time, so that it still goes when it is
        // too old or too much, or when the user clears the list.
        const at = Math.round((await fsp.stat(file(id)).catch(() => null))?.mtimeMs || 0);
        if (at) {
          index.set(id, {
            id, label: "Can't be read on this computer", source: null, connector: null,
            start: at, end: at, ended: null, steps: 0, failed: 0, unreadable: true,
          });
        }
        continue;
      }
      await encryptOld(data.id);
      if (data.source === 'panel' && dayOf(data.start) === dayOf(Date.now()) && !live.has('panel')) {
        data.end = null;
        data.ended = null;
        live.set('panel', { data, off: false, saving: null, timer: null });
      } else if (!data.ended) {
        data.end = lastTime(data);
        data.ended = data.source === 'panel' ? 'day' : 'quit';
        await fsp.writeFile(file(data.id), pack(data), { mode: 0o600 }).catch(() => {});
      }
      index.set(data.id, summary(data));
    }
    await prune();
  }
  const ready = load().catch(() => {});
  setInterval(prune, 60 * 60 * 1000).unref();

  // ── for the window chrome ───────────────────────────────────────────────
  async function list() {
    await ready;
    return {
      keepDays: keepDays(),
      items: [...index.values()].map((s) => ({ ...s, live: s.source !== 'panel' && [...live.values()].some((l) => l.data.id === s.id) }))
        .sort((a, b) => b.start - a.start),
    };
  }

  // A whole log, its pictures as data URLs (the window's page cannot load
  // files from the profile). have: the numbers of the steps whose pictures
  // the window already holds; those come back as true, not sent again.
  async function get(id, have) {
    await ready;
    const log = [...live.values()].find((l) => l.data.id === id);
    const data = log ? JSON.parse(JSON.stringify(log.data)) : index.has(id) ? await read(id) : null;
    if (!data) return null;
    const held = new Set(Array.isArray(have) ? have : []);
    for (const [i, s] of data.steps.entries()) {
      if (!s.thumb) continue;
      if (held.has(i)) { s.thumb = true; continue; }
      try {
        const bytes = box.open(await fsp.readFile(path.join(pictures(id), s.thumb)));
        s.thumb = `data:image/jpeg;base64,${bytes.toString('base64')}`;
      } catch {
        delete s.thumb;
      }
    }
    return { ...data, live: !!log && data.source !== 'panel' };
  }

  async function clear() {
    await ready;
    for (const id of [...index.keys()]) await remove(id);
  }

  function keep(days) {
    if (!Number.isFinite(days) || days < 0) return;
    settings.activityDays = days;
    save();
    prune();
    tell();
  }

  // Unwritten changes, at quit. Logs of sessions still running stay
  // unfinished and are marked as cut short at the next start.
  function flush() {
    for (const log of live.values()) {
      if (!log.timer || log.off) continue;
      clearTimeout(log.timer);
      log.timer = null;
      try { fs.writeFileSync(file(log.data.id), pack(log.data), { mode: 0o600 }); } catch {}
    }
  }

  return {
    open, end, step, consent, guard, list, get, remove: (id) => ready.then(() => remove(id)), clear, keep, flush, prune,
    probes: {
      'activity:list': () => list(),
      'activity:get': (arg) => (arg?.id ? get(arg.id, arg.have) : get(arg)),
      'activity:flush': async () => { for (const log of live.values()) { clearTimeout(log.timer); log.timer = null; await write(log); } return 'ok'; },
      'activity:prune': async () => { await ready; await prune(); return 'ok'; },
    },
  };
}

module.exports = { createActivity };
