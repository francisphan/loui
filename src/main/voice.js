// Voice for the Claude panel: reading replies aloud, and dictation.
//
// Reading aloud is done by the window chrome with the system's voices
// (src/ui/voice.js); this file only keeps the setting.
//
// Dictation: the window chrome records the microphone and sends the sound
// here; a hidden page of Loui's own (src/ui/voice-page.html) turns it into
// text with a small Whisper model, on this machine. Nothing is sent anywhere
// and nothing is written to disk. The model is downloaded once, by this
// process, into <profile>/voice/. The hidden page exists only while dictation
// is in use: it is made on demand and closed half a minute after the last
// use, which gives its memory back.
//
// The hidden page runs in a session of its own that serves it from loui-voice:
// addresses and refuses every other request, so it could not send the sound
// out even if it tried. Only a normal window's chrome can ask for any of this:
// no tool, Claude session, web page or private window can start the
// microphone, read what was said, or make Loui speak.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { app, BrowserWindow, ipcMain, protocol, session, webContents } = require('electron');

// Before the app is ready: the hidden page needs a real origin (for workers
// and fetch) and cross-origin isolation (for threads, which make it several
// times faster).
protocol.registerSchemesAsPrivileged([
  { scheme: 'loui-voice', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Whisper base, multilingual (English and Spanish among its languages), with
// 8-bit weights: about 77 MB on disk. The revision and hashes are fixed so a
// download can only ever be these exact files.
const MODEL = {
  id: 'Xenova/whisper-base',
  revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
  files: [
    ['config.json', 2248, 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b'],
    ['generation_config.json', 3776, '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05'],
    ['preprocessor_config.json', 339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
    ['tokenizer.json', 2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'],
    ['tokenizer_config.json', 282683, '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'],
    ['onnx/encoder_model_quantized.onnx', 23200850, '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9'],
    ['onnx/decoder_model_merged_quantized.onnx', 53707539, 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861'],
  ].map(([name, size, sha256]) => ({ name, size, sha256 })),
};
const HOST = 'https://huggingface.co';
const MODEL_MB = 77; // as the panel says it
// The languages the model writes down (Whisper's), for Settings: English and
// Spanish first, the rest by name.
const LANGUAGES = [['en', 'English'], ['es', 'Spanish'], ...Object.entries({
  af: 'Afrikaans', sq: 'Albanian', am: 'Amharic', ar: 'Arabic', hy: 'Armenian', as: 'Assamese', az: 'Azerbaijani', ba: 'Bashkir',
  eu: 'Basque', be: 'Belarusian', bn: 'Bengali', bs: 'Bosnian', br: 'Breton', bg: 'Bulgarian', my: 'Burmese', yue: 'Cantonese',
  ca: 'Catalan', zh: 'Chinese', hr: 'Croatian', cs: 'Czech', da: 'Danish', nl: 'Dutch', et: 'Estonian', fo: 'Faroese',
  fi: 'Finnish', fr: 'French', gl: 'Galician', ka: 'Georgian', de: 'German', el: 'Greek', gu: 'Gujarati', ht: 'Haitian Creole',
  ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian', is: 'Icelandic', id: 'Indonesian', it: 'Italian',
  ja: 'Japanese', jw: 'Javanese', kn: 'Kannada', kk: 'Kazakh', km: 'Khmer', ko: 'Korean', lo: 'Lao', la: 'Latin', lv: 'Latvian',
  ln: 'Lingala', lt: 'Lithuanian', lb: 'Luxembourgish', mk: 'Macedonian', mg: 'Malagasy', ms: 'Malay', ml: 'Malayalam',
  mt: 'Maltese', mi: 'Maori', mr: 'Marathi', mn: 'Mongolian', ne: 'Nepali', no: 'Norwegian', nn: 'Nynorsk', oc: 'Occitan',
  ps: 'Pashto', fa: 'Persian', pl: 'Polish', pt: 'Portuguese', pa: 'Punjabi', ro: 'Romanian', ru: 'Russian', sa: 'Sanskrit',
  sr: 'Serbian', sn: 'Shona', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', so: 'Somali', su: 'Sundanese',
  sw: 'Swahili', sv: 'Swedish', tl: 'Tagalog', tg: 'Tajik', ta: 'Tamil', tt: 'Tatar', te: 'Telugu', th: 'Thai', bo: 'Tibetan',
  tr: 'Turkish', tk: 'Turkmen', uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese', cy: 'Welsh', yi: 'Yiddish', yo: 'Yoruba',
})];
const RATES = [0.75, 1, 1.25, 1.5, 2]; // the speeds Settings offers
// Loaded, the model's page holds about 1.4 GB, so it goes soon after the last
// dictation. It is loading again by the time the next one has been spoken.
const IDLE_MS = 30 * 1000;
const MAX_SAMPLES = 16000 * 60 * 5; // five minutes of sound at most in one go
// A download from which nothing has arrived for this long is given up, so a
// stalled connection does not leave it "downloading" until Loui restarts.
const STALL_MS = Number(process.env.LOUI_TEST && process.env.LOUI_VOICE_STALL_MS) || 30 * 1000;

// What the hidden page may load, besides its own two files and the model.
const LIB = {
  'transformers.min.js': '@huggingface/transformers/dist/transformers.min.js',
  'ort-wasm-simd-threaded.asyncify.mjs': 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm': 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };
const HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:",
};

// settings: Loui's (readBack, readBackVoice, readBackRate, dictation,
// dictationLanguages). emit(w, payload): to one window's chrome.
function createVoice({ home, settings, save, tabs, changed, emit, lockToApp }) {
  const dir = process.env.LOUI_VOICE_DIR || path.join(home, 'voice', 'whisper-base');
  // The tests' stand-in for the model host (it serves small files, so sizes and hashes are not checked).
  const testHost = process.env.LOUI_TEST ? process.env.LOUI_VOICE_HOST : null;
  const files = testHost ? MODEL.files.map((f) => ({ name: f.name })) : MODEL.files;

  const usable = (w) => !!w && !w.private && !w.win.isDestroyed();
  const dictation = () => settings.dictation !== false;
  const languages = () => {
    const list = Array.isArray(settings.dictationLanguages) ? settings.dictationLanguages.filter((l) => /^[a-z]{2,3}$/.test(l)) : [];
    return list.length ? list : ['en', 'es'];
  };

  // ── the model on disk ──────────────────────────────────────────────────────
  const have = (f) => {
    try { return f.size ? fs.statSync(path.join(dir, f.name)).size === f.size : fs.existsSync(path.join(dir, f.name)); } catch { return false; }
  };
  let disk = files.every(have); // looked at once, and again around a download or a failure
  const onDisk = () => disk;

  let getting = null; // the download in flight: every caller waits for the same one
  let progress = null; // { percent } while it runs, for a window that opens meanwhile
  let stop = null; // ends the download in flight (cancel())
  // The user pressed the microphone again while the model was coming: the
  // download stops, and what had arrived of the file under way is removed.
  function cancel() { stop?.abort(); }
  function download(report) {
    disk = files.every(have);
    if (disk) return Promise.resolve();
    getting ??= (async () => {
      const mine = stop = new AbortController();
      const missing = files.filter((f) => !have(f));
      const total = missing.reduce((sum, f) => sum + (f.size || 0), 0);
      let got = 0, shown = -1;
      for (const f of missing) {
        const to = path.join(dir, f.name);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        let stalled = false, quiet = null;
        const alive = () => { clearTimeout(quiet); quiet = setTimeout(() => { stalled = true; mine.abort(); }, STALL_MS); };
        try {
          alive();
          const res = await fetch(`${testHost || HOST}/${MODEL.id}/resolve/${MODEL.revision}/${f.name}`, { signal: mine.signal });
          if (!res.ok) throw new Error(`the model host answered ${res.status}`);
          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(`${to}.part`);
          try {
            for await (const chunk of res.body) {
              alive();
              hash.update(chunk);
              if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
              got += chunk.length;
              const percent = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
              if (percent !== shown) { shown = percent; progress = { percent }; report(progress); }
            }
          } finally {
            await new Promise((r) => out.end(r));
          }
          if (f.sha256 && hash.digest('hex') !== f.sha256) throw new Error('a downloaded file was not the expected one');
          fs.renameSync(`${to}.part`, to);
        } catch (e) {
          fs.rmSync(`${to}.part`, { force: true }); // the next attempt starts afresh
          throw stalled ? Object.assign(new Error('the download stalled'), { stalled: true }) : e;
        } finally {
          clearTimeout(quiet);
        }
      }
      disk = files.every(have);
    })().catch((e) => { throw !e?.stalled && stop?.signal.aborted ? Object.assign(new Error('cancelled'), { cancelled: true }) : e; })
      .finally(() => { getting = null; progress = null; stop = null; changed(); });
    return getting;
  }

  // "Remove" in Settings: the model's files go; the next press of the microphone offers to fetch them again.
  function removeModel() {
    if (getting) return;
    close();
    for (const f of files) fs.rmSync(path.join(dir, f.name), { force: true });
    disk = files.every(have);
    changed();
  }

  // ── the hidden page ────────────────────────────────────────────────────────
  let ses = null;
  let page = null; // { win, ready: Promise, waiting: Map(id -> { ok, no }) }
  let idle = null;
  let seq = 0;

  function serve(request) {
    const { host, pathname } = new URL(request.url);
    const name = decodeURIComponent(pathname.slice(1));
    let file = null;
    if (host !== 'app') file = null;
    else if (name === 'page.html' || name === 'page.js') file = path.join(__dirname, '../ui', `voice-${name}`);
    else if (name.startsWith('lib/') && LIB[name.slice(4)]) file = path.join(__dirname, '../../node_modules', LIB[name.slice(4)]);
    else if (name.startsWith(`models/${MODEL.id}/`)) {
      const f = files.find((x) => x.name === name.slice(`models/${MODEL.id}/`.length));
      file = f ? path.join(dir, f.name) : null;
    }
    if (!file || !fs.existsSync(file)) return new Response('', { status: 404, headers: HEADERS });
    // Streamed, so the model is not held here as well as in the page.
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      headers: { ...HEADERS, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' },
    });
  }

  function close() {
    clearTimeout(idle);
    const was = page;
    page = null;
    if (!was) return;
    for (const w of was.waiting.values()) w.no(new Error('dictation was closed'));
    if (!was.win.isDestroyed()) was.win.destroy();
  }

  function open() {
    if (page) return page;
    if (!ses) {
      ses = session.fromPartition('loui-voice'); // kept in memory only
      ses.protocol.handle('loui-voice', serve);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('loui-voice://app/') }));
      // WebRTC answers to neither of those. Its only way out is made a proxy
      // that is not there (and plain UDP is switched off below).
      ses.setProxy({ proxyRules: 'http://127.0.0.1:9' }).catch(() => {});
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses, preload: path.join(__dirname, 'voice-preload.js'), sandbox: true, contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    lockToApp(win.webContents);
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const mine = { win, waiting: new Map() };
    mine.ready = new Promise((ok, no) => { mine.loaded = ok; mine.failed = no; });
    mine.ready.catch(() => {}); // each request reports it
    // The page's process dying, or the page failing to load: whoever waits is told.
    const lost = (why) => { mine.failed(new Error(why)); disk = files.every(have); if (page === mine) close(); };
    win.webContents.on('render-process-gone', () => lost('the speech model stopped (it may have run out of memory)'));
    win.webContents.on('did-fail-load', () => lost('the speech model could not be loaded'));
    if (process.env.LOUI_DEBUG) win.webContents.on('console-message', (e) => console.error('[voice]', e.message));
    win.loadURL('loui-voice://app/page.html');
    page = mine;
    return mine;
  }

  ipcMain.on('voice-page', (e, msg) => {
    if (!page || e.sender !== page.win.webContents || !msg) return; // only the hidden page
    if (msg.type === 'ready') return page.loaded();
    if (msg.type === 'failed') { page.failed(new Error(String(msg.text))); return close(); } // the model did not load
    const w = page.waiting.get(msg.id);
    if (!w) return;
    page.waiting.delete(msg.id);
    if (msg.type === 'text') w.ok({ text: String(msg.text || ''), language: msg.language, ms: msg.ms });
    else w.no(new Error(String(msg.text)));
  });

  // Sound (16 kHz, one channel) to text: { text, language, ms }.
  async function transcribe(audio) {
    if (!(audio instanceof Float32Array) || !audio.length || audio.length > MAX_SAMPLES) throw new Error('there was nothing to write down');
    if (!onDisk()) throw new Error('the speech model has not been downloaded yet');
    const p = open();
    clearTimeout(idle);
    try {
      await p.ready;
      const id = ++seq;
      return await new Promise((ok, no) => {
        p.waiting.set(id, { ok, no });
        p.win.webContents.send('voice-page', { id, audio, languages: languages() });
      });
    } finally {
      if (page === p && !p.waiting.size) idle = setTimeout(close, IDLE_MS);
    }
  }

  // ── requests from a window's chrome ────────────────────────────────────────
  // Run inside tabs.as(w): the window is captured before anything is awaited.
  let voices = null; // the system's voices, as the window chrome last reported them: [{ name, lang }]
  function handle({ do: what, on, id, audio, list } = {}) {
    const w = tabs.window();
    if (!usable(w)) return;
    const reply = (payload) => { if (usable(w)) emit(w, payload); };
    if (what === 'read-back') {
      settings.readBack = !!on;
      save();
      return changed();
    }
    if (what === 'voices') { // asked for by askVoices()
      voices = (Array.isArray(list) ? list : []).slice(0, 400)
        .filter((v) => v && typeof v.name === 'string' && v.name)
        .map((v) => ({ name: v.name.slice(0, 120), lang: typeof v.lang === 'string' ? v.lang.slice(0, 20) : '' }));
      return changed();
    }
    if (what === 'cancel') return cancel();
    if (!dictation()) return;
    if (what === 'prepare') {
      // Gets the model if it is not here yet, and starts loading it so it is ready when the talking stops.
      download((p) => { changed(); reply({ type: 'model', status: 'downloading', ...p }); })
        .then(() => { open(); clearTimeout(idle); idle = setTimeout(close, IDLE_MS); reply({ type: 'model', status: 'ready' }); })
        .catch((e) => reply({ type: 'model', status: e.cancelled ? 'cancelled' : 'failed', text: e.message || String(e) }));
    } else if (what === 'transcribe') {
      transcribe(audio)
        .then((got) => reply({ type: 'text', id, text: got.text }))
        .catch((e) => reply({ type: 'text', id, failed: e.message || String(e) }));
    }
  }

  // For one window's chrome. Only one window reads replies aloud: the normal
  // window the user was in last.
  const state = (w) => ({
    voice: w.private ? { readBack: false, speaks: false, dictation: false } : {
      readBack: settings.readBack === true,
      speaks: w === tabs.normalWindow(),
      voice: typeof settings.readBackVoice === 'string' ? settings.readBackVoice : '',
      rate: Math.min(3, Math.max(0.5, Number(settings.readBackRate) || 1)),
      dictation: dictation(),
      model: onDisk() ? 'ready' : progress ? 'downloading' : 'missing',
    },
  });

  // ── for the Settings window (Claude › Voice) ───────────────────────────────
  // Voices are the system's, which only a page can list: the chrome of the
  // window that reads aloud is asked, and answers through handle().
  const speaker = () => { const w = tabs.normalWindow(); return usable(w) ? w : null; };
  function askVoices() {
    const w = speaker();
    if (w) emit(w, { type: 'voices?' });
  }
  const rate = () => Math.min(3, Math.max(0.5, Number(settings.readBackRate) || 1));
  const prefs = () => ({
    readBack: settings.readBack === true,
    voice: typeof settings.readBackVoice === 'string' ? settings.readBackVoice : '',
    voices, // null until a window has said
    rate: rate(), rates: RATES,
    dictation: dictation(),
    languages: LANGUAGES.map(([code, name]) => ({ code, name, on: languages().includes(code) })),
    model: onDisk() ? 'ready' : progress ? 'downloading' : 'missing', percent: progress?.percent || 0, mb: MODEL_MB,
    shortcut: 'Ctrl+Shift+Space',
  });
  const acts = {
    'voice:read-back': (on) => { settings.readBack = !!on; save(); changed(); },
    'voice:voice': (name) => {
      if (typeof name !== 'string' || (name && !(voices || []).some((v) => v.name === name))) return;
      if (name) settings.readBackVoice = name; else delete settings.readBackVoice;
      save();
      changed();
    },
    'voice:rate': (r) => { if (RATES.includes(Number(r))) { settings.readBackRate = Number(r); save(); changed(); } },
    // "Play sample": a sentence in the chosen voice and speed, said by the main window.
    'voice:sample': () => { const w = speaker(); if (w) emit(w, { type: 'sample' }); },
    'voice:dictation': (on) => { settings.dictation = !!on; save(); changed(); },
    // One language ticked or unticked. The last one stays: there must be one to write down.
    'voice:language': ({ code, on } = {}) => {
      if (!LANGUAGES.some(([c]) => c === code)) return;
      const now = languages().filter((l) => l !== code);
      if (on) now.push(code);
      if (!now.length) return;
      settings.dictationLanguages = LANGUAGES.map(([c]) => c).filter((c) => now.includes(c));
      save();
      changed();
    },
    'voice:model-remove': () => removeModel(),
  };

  // Loui's own pages share Electron's default session, where nothing asked
  // before now. The microphone is for a normal window's chrome alone; the
  // camera is for nobody.
  const micFor = (wc, types) => usable(tabs.windowOf(wc)) && dictation() && types.length > 0 && types.every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' ? micFor(wc, details?.mediaTypes || []) : true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => (
    permission === 'media' ? micFor(wc, [details?.mediaType].filter(Boolean)) : true
  ));

  // A 16-bit WAV file's sound (the tests' way to speak).
  function wav(file) {
    const b = fs.readFileSync(file);
    const from = b.indexOf('data', 12, 'latin1') + 8;
    const out = new Float32Array(Math.floor((b.length - from) / 2));
    for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(from + i * 2) / 32768;
    return out;
  }
  const probes = {
    // kb: what the hidden page's process holds, as the task manager counts it.
    'voice:state': () => {
      const pid = page && !page.win.isDestroyed() ? page.win.webContents.getOSProcessId() : 0;
      const m = app.getAppMetrics().find((x) => x.pid === pid)?.memory;
      return { loaded: !!page, onDisk: onDisk(), dir, pid, kb: m ? m.workingSetSize : 0, privateKb: m?.privateBytes ?? null };
    },
    'voice:open': () => open().ready.then(() => 'ok'),
    'voice:transcribe-wav': (file) => transcribe(wav(file)),
    'voice:close': () => { close(); return 'ok'; },
    // The hidden page's ways out, and whether it still loads with them shut.
    'voice:lockdown': async () => {
      const p = open();
      const wc = p.win.webContents;
      const webrtc = wc.getWebRTCIPHandlingPolicy();
      const loaded = await new Promise((r) => {
        wc.once('did-finish-load', () => r('loaded'));
        wc.once('did-fail-load', () => r('failed'));
        p.ready.then(() => r('ran'), (e) => r(`ran: ${e.message}`)); // its script ran, with or without a model
      });
      return { webrtc, proxy: await ses.resolveProxy('https://example.com/'), loaded };
    },
    // Asks for the microphone from each of Loui's pages that is not a normal window's chrome.
    'voice:mic-elsewhere': () => Promise.all(webContents.getAllWebContents()
      .filter((wc) => wc.session === session.defaultSession && !usable(tabs.windowOf(wc)))
      .map((wc) => wc.executeJavaScript("navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'allowed'; }, (e) => e.name)"))),
  };

  return { handle, state, probes, prefs, acts, askVoices, page: () => page?.win.webContents || null };
}

module.exports = { createVoice };
