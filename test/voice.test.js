// Voice in the Claude panel: reading replies aloud and dictation. There is no
// sound under the tests, so what speaks, hears and recognises speech is
// replaced through voice.seams (src/ui/voice.js); the real microphone path
// runs against Chromium's fake device, and the real model only when
// LOUI_TEST_VOICE is set (it is a 77 MB download; LOUI_VOICE_DIR reuses one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

let b, home, host;
let serving = 'ok'; // how the stand-in model host answers: 'ok', 'fail', or 'hold'
const held = [];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (what, check, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const chrome = (code, id) => (id ? b.ui('in-window', { window: id, ui: 'chrome:eval', arg: code }) : b.ui('chrome:eval', code));
// Something the panel's conversation says, once the window has taken it in.
let sent = 0;
const chat = async (event) => {
  await b.ui('chat:emit', event);
  sent++;
  await wait('the window to hear the conversation', async () => (await chrome('fake.seen')) >= sent, 5000);
};
const reply = async (...pieces) => {
  await chat({ type: 'start' });
  await chat({ type: 'text-start' });
  for (const text of pieces) await chat({ type: 'text', text });
};
const done = () => chat({ type: 'done' });
const spoken = () => chrome('fake.spoken');
const settings = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
const pressed = (id) => chrome(`document.getElementById('${id}').getAttribute('aria-pressed')`);
const key = (type, init, on = "document.getElementById('prompt')") =>
  chrome(`void ${on}.dispatchEvent(new KeyboardEvent('${type}', ${JSON.stringify({ bubbles: true, ...init })}))`);
const mic = () => chrome(`(() => {
  const m = document.getElementById('mic'), n = document.getElementById('voice-note');
  return { cls: m.className, pressed: m.getAttribute('aria-pressed'), text: m.textContent, hidden: m.hidden, note: n.hidden ? '' : n.textContent, trouble: n.classList.contains('trouble') };
})()`);
// Sets the fakes, or the message box (value, and where the cursor is).
const set = (fields) => chrome(`void Object.assign(fake, ${JSON.stringify(fields)})`);
const box = (value, at = value.length) => chrome(`{ const p = document.getElementById('prompt'); p.value = ${JSON.stringify(value)}; p.setSelectionRange(${at}, ${at}); }`);
const boxValue = () => chrome("document.getElementById('prompt').value");
const press = (id) => chrome(`void document.getElementById('${id}').click()`);
const loud = (seconds) => chrome(`void fake.hear(new Float32Array(${Math.round(seconds * 16000)}).fill(0.4))`);

// Stand-ins for the three things that need sound, keeping the real ones aside.
const FAKES = `(() => {
  const fake = window.fake = {
    real: { ...voice.seams },
    spoken: [], cancelled: 0, ends: [], spokenWith: null,
    hear: null, micStarts: 0, micStops: 0, micFails: null,
    have: true, text: 'hello world', asked: 0, fail: null, hold: false, release: null,
    seen: 0,
  };
  loui.on('chat', () => { fake.seen++; }); // after voice.js has had each one
  voice.seams.speech = {
    speak(text, options, done) { fake.spoken.push(text); fake.spokenWith = options; fake.ends.push(done); },
    cancel() { fake.cancelled++; fake.ends.length = 0; },
  };
  voice.seams.mic = {
    async start(heard) {
      if (fake.micFails) throw Object.assign(new Error('no'), { name: fake.micFails });
      fake.hear = heard;
      fake.micStarts++;
      return async () => { fake.micStops++; };
    },
  };
  voice.seams.recogniser = {
    have: () => fake.have,
    prepare: async () => {},
    async transcribe(audio) {
      fake.asked++;
      if (fake.hold) await new Promise((r) => { fake.release = r; });
      if (fake.fail) throw new Error(fake.fail);
      return fake.text;
    },
  };
})()`;

test.before(async () => {
  // The model host's stand-in: small files, slow or failing on request.
  host = http.createServer((req, res) => {
    if (serving === 'fail') return res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('part');
    if (serving === 'hold') held.push(res);
    else res.end('rest');
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-voice-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ readBackVoice: 'A Voice', readBackRate: 1.3 }));
  b = await launch({
    LOUI_VOICE_HOST: `http://127.0.0.1:${host.address().port}`,
    LOUI_VOICE_STALL_MS: '3000',
    ...(process.env.LOUI_VOICE_DIR ? {} : { LOUI_VOICE_DIR: path.join(home, 'voice', 'whisper-base') }),
  }, { home });
  await chrome(FAKES);
});
test.after(async () => {
  await b.close();
  for (const res of held) res.destroy();
  host.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('reading aloud is off until the speaker in the panel head is pressed, and the choice is kept', async () => {
  assert.equal(await pressed('readback'), 'false');
  assert.equal((await b.state()).voice.readBack, false);
  await reply('Nobody hears this. ');
  await done();
  assert.deepEqual(await spoken(), []);

  await press('readback');
  await wait('the toggle to be on', async () => (await pressed('readback')) === 'true');
  assert.equal(settings().readBack, true);
  assert.equal((await b.state()).voice.speaks, true);
});

test('a reply is read a sentence at a time as it arrives: prose only, with the chosen voice and rate', async () => {
  await reply('Here is **the** answer. And so');
  await wait('the first sentence, before the reply is complete', async () => (await spoken()).length === 1);
  assert.deepEqual(await spoken(), ['Here is the answer.']);
  assert.deepEqual(await chrome('fake.spokenWith'), { voice: 'A Voice', rate: 1.3 });
  assert.equal(await chrome("document.getElementById('readback').classList.contains('speaking')"), true);

  await chat({ type: 'text', text: ' on.\n\nSee [the docs](https://example.com/a/b) or https://www.example.org/x/y?z=1 for more.\n\n```js\ncon' });
  await chat({ type: 'text', text: 'st secret = 1;\n```\n\n1. First `thing`\n2. Second' });
  await done();
  assert.deepEqual(await spoken(), [
    'Here is the answer.', 'And so on.', 'See the docs or example.org for more.', 'code block', 'First thing', 'Second',
  ]);

  // Once everything queued has been said the toggle rests.
  await chrome('void fake.ends.splice(0).forEach((end) => end())');
  assert.equal(await chrome("document.getElementById('readback').classList.contains('speaking')"), false);
  assert.equal(await pressed('readback'), 'true');
});

test('pressing the speaker while it talks silences that reply and leaves reading aloud on', async () => {
  await set({ spoken: [], cancelled: 0 });
  await reply('One. ');
  await press('readback');
  assert.equal(await chrome('fake.cancelled'), 1);
  await chat({ type: 'text', text: 'Two. ' });
  await done();
  assert.deepEqual(await spoken(), ['One.']);
  assert.equal(await pressed('readback'), 'true');
  assert.equal(settings().readBack, true);

  await reply('The next reply is read. ');
  await done();
  assert.deepEqual(await spoken(), ['One.', 'The next reply is read.']);
});

test('it stops at once on Esc, Stop, a new message, a new conversation, and when turned off', async () => {
  const cut = async (how, after = async () => {}) => {
    await set({ spoken: [], cancelled: 0 });
    await reply('Something long. ');
    await how();
    assert.equal(await chrome('fake.cancelled') >= 1, true, 'speech was cut off');
    assert.equal(await chrome("document.getElementById('readback').classList.contains('speaking')"), false);
    await after();
  };
  const unsaid = async () => {
    await chat({ type: 'text', text: 'More of the same reply. ' });
    await done();
    assert.deepEqual(await spoken(), ['Something long.']);
  };
  await cut(() => key('keydown', { key: 'Escape' }), unsaid);
  // Stop is the composer's button while Claude answers; pressing it submits the form.
  await cut(() => chrome("void document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true }))"), unsaid);
  await cut(() => chat({ type: 'stopped' }), unsaid);
  await cut(() => chat({ type: 'reset' }), unsaid);
  await cut(() => chat({ type: 'user', text: 'next', picks: [] }));

  await cut(async () => {
    await press('readback'); // silences it…
    await press('readback'); // …and this turns it off
    await wait('the toggle to be off', async () => (await pressed('readback')) === 'false');
  });
  assert.equal(settings().readBack, false);
  await reply('Off means off. ');
  await done();
  assert.deepEqual(await spoken(), ['Something long.']);
  await b.ui('voice', { do: 'read-back', on: true });
  await wait('the toggle to be on again', async () => (await pressed('readback')) === 'true');
  await chat({ type: 'reset' });
});

test('dictation: the microphone listens, shows what it hears, and puts the words at the cursor without sending', async () => {
  await box('one two', 3);
  await set({ spoken: [], cancelled: 0 });
  await reply('Still talking. ');
  assert.deepEqual(await mic(), { cls: 'idle', pressed: 'false', text: '', hidden: false, note: '', trouble: false });

  await press('mic');
  await wait('listening', async () => (await mic()).cls === 'listening');
  assert.equal((await mic()).pressed, 'true');
  assert.equal((await mic()).note, 'Listening…');
  assert.equal(await chrome('fake.cancelled') >= 1, true, 'starting to dictate stops the reading');
  await chat({ type: 'text', text: 'Not said over the user. ' });
  assert.deepEqual(await spoken(), ['Still talking.']);
  await done();

  // What has been said so far shows while the talking goes on.
  await loud(1.5);
  await wait('the words so far', async () => (await mic()).note === 'hello world', 6000);

  await set({ text: 'hello there world' });
  await press('mic');
  await wait('the words in the box', async () => (await boxValue()) === 'one hello there world two');
  assert.equal(await chrome('fake.micStops'), 1);
  assert.deepEqual(await mic(), { cls: 'idle', pressed: 'false', text: '', hidden: false, note: '', trouble: false });
  assert.equal(await chrome("document.getElementById('prompt').selectionStart"), 'one hello there world'.length);
  assert.equal(await chrome("document.activeElement.id"), 'prompt');
  // Never sent: nothing went to the conversation, and Send is there to press.
  assert.equal(await chrome("document.querySelectorAll('#feed .said').length"), 0);
  assert.equal(await chrome("document.getElementById('send').disabled"), false);
  assert.equal(await chrome("document.getElementById('send').textContent"), 'Send');
});

test('Esc stops dictation and keeps the words; Esc while they are written down drops them', async () => {
  await box('');
  await set({ text: 'First part.' });
  await press('mic');
  await wait('listening', async () => (await mic()).cls === 'listening');
  await loud(1);
  await key('keydown', { key: 'Escape' });
  await wait('the words', async () => (await boxValue()) === 'First part.');

  await set({ hold: true, text: 'Never mind.' });
  await press('mic');
  await wait('listening', async () => (await mic()).cls === 'listening');
  await loud(0.5);
  await press('mic');
  await wait('writing it down', async () => (await mic()).cls === 'writing');
  await key('keydown', { key: 'Escape' });
  assert.equal((await mic()).cls, 'idle');
  await chrome('void (fake.hold = false, fake.release())');
  await pause(200);
  assert.equal(await boxValue(), 'First part.');
});

test('holding Ctrl+Shift+Space talks; letting go writes it down', async () => {
  await box('So');
  await set({ text: 'it goes.' });
  await key('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true });
  await wait('listening', async () => (await mic()).cls === 'listening');
  await key('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, repeat: true });
  await loud(1);
  assert.equal((await mic()).cls, 'listening');
  await key('keyup', { code: 'Space', key: ' ' }, 'window');
  await wait('the words', async () => (await boxValue()) === 'So it goes.');
});

test('silence, a missing microphone and a recogniser that fails each say so, and nothing is typed', async () => {
  await box('');
  await set({ asked: 0 });
  await press('mic');
  await wait('listening', async () => (await mic()).cls === 'listening');
  await chrome('void fake.hear(new Float32Array(16000))'); // a second of nothing
  await press('mic');
  await wait('a note', async () => /heard nothing/.test((await mic()).note));
  assert.equal(await chrome('fake.asked'), 0);

  await set({ micFails: 'NotFoundError' });
  await press('mic');
  await wait('a note', async () => /no microphone/.test((await mic()).note));
  assert.equal((await mic()).trouble, true);
  assert.match((await mic()).note, /Win\+H/);
  assert.equal((await mic()).cls, 'idle');

  await set({ micFails: null, fail: 'it broke' });
  await press('mic');
  await wait('listening', async () => (await mic()).cls === 'listening');
  await loud(0.5);
  await press('mic');
  await wait('a note', async () => /Dictation did not work: it broke/.test((await mic()).note));
  assert.equal(await boxValue(), '');
  await set({ fail: null });
});

test('the speech model is fetched on first use, with progress on the button and a clear failure', async () => {
  await chrome('void (voice.seams.recogniser = fake.real.recogniser)');
  assert.equal((await b.state()).voice.model, 'missing');
  const micStarts = await chrome('fake.micStarts');
  serving = 'fail';
  await press('mic');
  await wait('the failure', async () => (await mic()).trouble);
  assert.match((await mic()).note, /could not be fetched: the model host answered 503\..*try again.*Win\+H/);
  assert.equal((await mic()).cls, 'idle');

  // A connection that goes quiet is given up, and leaves nothing behind.
  serving = 'hold';
  await press('mic');
  await wait('the download to show', async () => (await mic()).cls === 'getting');
  await wait('the stalled download to be given up', async () => (await mic()).trouble);
  assert.match((await mic()).note, /could not be fetched: the download stalled\..*press the microphone to try again/);
  assert.equal((await mic()).cls, 'idle');
  assert.equal((await b.state()).voice.model, 'missing');
  const dir = (await b.ui('voice:state')).dir;
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.part')), []);
  for (const res of held.splice(0)) res.destroy();

  await press('mic');
  await wait('the download to show', async () => (await mic()).cls === 'getting');
  assert.match((await mic()).text, /^\d+%$/);
  assert.match((await mic()).note, /Getting the speech model/);
  assert.equal((await b.state()).voice.model, 'downloading');
  // Pressing again while it downloads does nothing.
  await press('mic');
  assert.equal((await mic()).cls, 'getting');

  serving = 'ok';
  held.shift().end('rest');
  await wait('the download to finish', async () => (await mic()).cls === 'idle');
  // It does not start listening by itself after the wait.
  assert.match((await mic()).note, /Dictation is ready/);
  assert.equal(await chrome('fake.micStarts'), micStarts, 'the microphone was not started');
  const state = await b.ui('voice:state');
  assert.equal(state.onDisk, true);
  assert.equal(fs.readFileSync(path.join(state.dir, 'onnx', 'encoder_model_quantized.onnx'), 'utf8'), 'partrest');
  assert.equal(fs.readdirSync(state.dir).some((f) => f.endsWith('.part')), false);
});

test('the hidden speech page has no way out over WebRTC, and still loads', async () => {
  const lock = await b.ui('voice:lockdown');
  assert.equal(lock.webrtc, 'disable_non_proxied_udp');
  assert.equal(lock.proxy, 'PROXY 127.0.0.1:9');
  assert.match(lock.loaded, /^(loaded|ran)/, 'its own address is served past the proxy');
  await b.ui('voice:close');
});

test('only a normal window\'s chrome gets the microphone, and only the microphone', async () => {
  // The real path, against Chromium's fake device: sound arrives at 16 kHz.
  const samples = await chrome(`(async () => {
    let n = 0;
    const stop = await fake.real.mic.start((piece) => { n += piece.length; });
    await new Promise((r) => setTimeout(r, 1500));
    await stop();
    return n;
  })()`);
  assert.ok(samples >= 8000 && samples <= 32000, `about a second and a half of sound (${samples} samples)`);
  assert.equal(await chrome("navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'allowed', (e) => e.name)"), 'NotAllowedError');

  // Loui's other pages (the address suggestions, the command palette) and a private window's chrome are refused.
  const priv = await b.ui('window:new', { private: true });
  await wait('the private window', async () => (await b.ui('in-window', { window: priv, ui: 'state' })).voice);
  const others = await b.ui('voice:mic-elsewhere');
  assert.ok(others.length >= 3, `asked from ${others.length} other pages`);
  assert.deepEqual([...new Set(others)], ['NotAllowedError']);

  // A private window has no voice at all, and cannot change the setting.
  const state = await b.ui('in-window', { window: priv, ui: 'state' });
  assert.deepEqual(state.voice, { readBack: false, speaks: false, dictation: false });
  assert.equal(await chrome("document.getElementById('mic').hidden", priv), true);
  await b.ui('in-window', { window: priv, ui: 'voice', arg: { do: 'read-back', on: false } });
  assert.equal(settings().readBack, true);
  await b.ui('window:close', priv);
});

test('with two windows, only the one the user was in last reads aloud', async () => {
  const first = (await b.ui('windows'))[0].id;
  const second = await b.ui('window:new');
  await wait('the second window', async () => (await b.ui('in-window', { window: second, ui: 'state' })).voice);
  await chrome(FAKES, second);
  await b.ui('window:focus', second);
  await wait('the second window to be the one that speaks', async () => (await chrome('state.voice.speaks', second)) === true);
  await wait('the first window to know it does not', async () => (await chrome('state.voice.speaks', first)) === false);
  await chrome('void (fake.spoken = [])', first);
  for (const event of [{ type: 'start' }, { type: 'text-start' }, { type: 'text', text: 'Said once. ' }, { type: 'done' }]) await b.ui('chat:emit', event);
  await wait('the second window to say it', async () => (await chrome('fake.spoken.length', second)) === 1);
  assert.deepEqual(await chrome('fake.spoken', second), ['Said once.']);
  await wait('the first window to have heard the whole reply', async () => (await chrome('fake.seen', first)) >= sent + 4);
  assert.deepEqual(await chrome('fake.spoken', first), []);
  await b.ui('window:close', second);
});

test('no tool, and nothing a page or session can reach, starts the microphone or speaks', () => {
  const tools = require('../src/shared/tools');
  assert.deepEqual(tools.filter((t) => /voice|speak|speech|dictat|microphone|listen/i.test(`${t.name} ${t.description}`)).map((t) => t.name), []);
  // The hidden page's bridge carries one channel, which the main process only hears from that page.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'voice.js'), 'utf8');
  assert.match(main, /e\.sender !== page\.win\.webContents/);
  assert.match(main, /lockToApp\(win\.webContents\)/);
});

test('the real model writes down a short recording', { skip: !process.env.LOUI_TEST_VOICE && 'set LOUI_TEST_VOICE=1 to run (downloads the model unless LOUI_VOICE_DIR has it)' }, async () => {
  const c = await launch(process.env.LOUI_VOICE_DIR ? {} : { LOUI_VOICE_DIR: path.join(os.tmpdir(), 'loui-voice-model') });
  try {
    // As the first press of the microphone does: fetch it if it is not there (checked against its hashes).
    await c.ui('chrome:eval', 'voice.seams.recogniser.prepare(() => {})');
    const got = await c.ui('voice:transcribe-wav', path.join(__dirname, 'fixture', 'voice', 'ask-not.wav'));
    assert.match(got.text, /my fellow Americans/i);
    assert.equal(got.language, 'en');
    const loaded = await c.ui('voice:state');
    console.log(`5.2 s of speech took ${got.ms} ms; the model's page holds ${Math.round(loaded.kb / 1024)} MB`);
    await c.ui('voice:close');
    assert.equal((await c.ui('voice:state')).loaded, false);
  } finally {
    await c.close();
  }
});
