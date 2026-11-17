// Voice for the Claude panel: reading Claude's replies aloud, and dictating
// into the message box. Both are the user's alone: nothing here listens to
// tools, sessions or pages, and a private window has neither.
//
// Reading aloud uses the system's voices. Dictation records the microphone
// here and has the sound turned into text on this machine (src/main/voice.js);
// what was said goes into the message box and is never sent by itself.
//
// The three things this file cannot do under test (speak, hear, recognise
// speech) sit behind `voice.seams`, which the tests replace.
const voice = (() => {
  const toggle = $('readback');
  const mic = $('mic');
  const note = $('voice-note');
  const box = $('prompt');

  const SPEAKER = svg('<path d="M2.5 6v4H5l3.5 3V3L5 6z"/><path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.6a6.2 6.2 0 0 1 0 8.8"/>');
  const SPEAKER_OFF = svg('<path d="M2.5 6v4H5l3.5 3V3L5 6z"/><path d="m11.2 6.2 3.3 3.6M14.5 6.2l-3.3 3.6"/>');
  const MIC = svg('<rect x="5.75" y="1.5" width="4.5" height="8" rx="2.25"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5"/>');

  const mine = () => state.voice || {};

  // ── seams ─────────────────────────────────────────────────────────────────
  const utterances = new Set(); // kept until each ends: Chromium forgets the events of one it has collected
  const waiting = new Map(); // id -> { ok, no } for sound being turned into text
  let preparing = null; // { progress, ok, no } while the model is fetched or loaded
  let asked = 0;
  const seams = {
    speech: {
      // Queues one utterance; done() once it has been said, or dropped.
      speak(text, { voice: name, rate }, done) {
        const u = new SpeechSynthesisUtterance(text);
        const chosen = name && speechSynthesis.getVoices().find((v) => v.name === name);
        if (chosen) u.voice = chosen;
        u.rate = rate;
        u.onend = u.onerror = () => { utterances.delete(u); done(); };
        utterances.add(u);
        speechSynthesis.speak(u);
      },
      cancel() {
        utterances.clear();
        speechSynthesis.cancel();
      },
    },
    mic: {
      // Starts listening: heard(Float32Array) for each tenth of a second, at
      // 16 kHz. Resolves with stop(), which resolves once the last of it is in.
      async start(heard) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const ctx = new AudioContext({ sampleRate: 16000 });
        const close = () => { for (const t of stream.getTracks()) t.stop(); ctx.close().catch(() => {}); };
        try {
          await ctx.audioWorklet.addModule('voice-worklet.js');
          const node = new AudioWorkletNode(ctx, 'voice-capture');
          node.port.onmessage = (e) => heard(e.data);
          ctx.createMediaStreamSource(stream).connect(node);
          node.connect(ctx.destination); // it plays nothing; connected so that it runs
        } catch (e) {
          close();
          throw e;
        }
        return () => new Promise((done) => setTimeout(() => { close(); done(); }, 200)); // the end of the last word
      },
    },
    recogniser: {
      have: () => mine().model === 'ready',
      // Resolves once the speech model is on this machine and loading;
      // progress(percent) while it downloads.
      prepare(progress) {
        return new Promise((ok, no) => {
          preparing = { progress, ok, no };
          loui.send('voice', { do: 'prepare' });
        });
      },
      // Sound (16 kHz) to text.
      transcribe(audio) {
        return new Promise((ok, no) => {
          const id = ++asked;
          waiting.set(id, { ok, no });
          loui.send('voice', { do: 'transcribe', id, audio });
        });
      },
    },
  };
  loui.on('voice', (e) => {
    if (e.type === 'model' && preparing) {
      if (e.status === 'downloading') return preparing.progress(e.percent);
      const { ok, no } = preparing;
      preparing = null;
      if (e.status === 'ready') ok();
      else no(new Error(e.text));
    } else if (e.type === 'text') {
      const w = waiting.get(e.id);
      waiting.delete(e.id);
      if (e.failed) w?.no(new Error(e.failed));
      else w?.ok(e.text);
    }
  });

  // ── reading replies aloud ─────────────────────────────────────────────────
  // Claude's prose only, a sentence at a time as it arrives. Not its steps;
  // of a code block only the words "code block"; of an address only the site.
  let prose = null; // { text, at, fence }: the run of prose being streamed, and how far it has been read
  let queued = 0; // utterances waiting or being said
  let round = 0; // goes up when speech is cut off: what was queued before no longer counts
  let hushed = false; // the user silenced this reply: nothing more of it is said

  const reading = () => !!mine().readBack && !!mine().speaks && !hushed && phase === 'idle';

  // Markdown as it would be said.
  function plain(text) {
    return text
      .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, '$1')
      .replace(/https?:\/\/[^\s)>\]]+/g, (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'a link'; } })
      .replace(/[`*_#|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function say(text) {
    text = plain(text);
    if (!reading() || !/[\p{L}\p{N}]/u.test(text)) return;
    const mineRound = round;
    queued++;
    drawToggle();
    seams.speech.speak(text, { voice: mine().voice, rate: mine().rate }, () => {
      if (mineRound !== round) return;
      queued--;
      drawToggle();
    });
  }

  // Says what has arrived of the prose and is whole: sentences, and lines
  // that have ended. all: the prose is complete, so what is left is said too.
  function read(p, all) {
    for (;;) {
      const lineStart = p.at === 0 || p.text[p.at - 1] === '\n';
      const rest = p.text.slice(p.at);
      const nl = rest.indexOf('\n');
      const whole = nl >= 0 || all;
      const line = nl >= 0 ? rest.slice(0, nl) : rest;
      if (!rest) return;
      if (lineStart) {
        // A code block is named, not read. A line that may yet turn out to open one waits.
        if (p.fence || /^\s*`{1,3}/.test(line)) {
          if (!whole) return;
          if (/^\s*```/.test(line)) {
            if (!p.fence) say('code block');
            p.fence = !p.fence;
          } else if (!p.fence) say(line);
          p.at += line.length + 1;
          continue;
        }
        // List and heading marks are not said (and "1." is not a sentence).
        const mark = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+|>\s*)/);
        if (mark && (whole || mark[0].length < line.length)) { p.at += mark[0].length; continue; }
        if (mark) return;
      }
      const end = line.match(/[.!?…:;]["')\]*_`]*(?=\s)/);
      if (end) {
        say(line.slice(0, end.index + end[0].length));
        p.at += end.index + end[0].length;
      } else if (whole) {
        say(line);
        p.at += line.length + 1;
      } else return;
    }
  }

  // Stops speaking at once. quiet: and says nothing more of this reply.
  function hush(quiet = false) {
    if (quiet) hushed = true;
    round++;
    queued = 0;
    seams.speech.cancel();
    drawToggle();
  }

  function drawToggle() {
    const on = !!mine().readBack;
    const speaking = queued > 0;
    toggle.innerHTML = on ? SPEAKER : SPEAKER_OFF;
    toggle.setAttribute('aria-pressed', on);
    toggle.classList.toggle('on', on);
    toggle.classList.toggle('speaking', speaking);
    toggle.title = speaking ? 'Reading this reply aloud. Press to stop it (Esc).' : on ? 'Reading replies aloud is on' : 'Read replies aloud';
    toggle.setAttribute('aria-label', speaking ? 'Stop reading this reply aloud' : 'Read replies aloud');
  }
  toggle.onclick = () => {
    if (queued > 0) return hush(true); // while it talks: silence this reply, keep the setting
    loui.send('voice', { do: 'read-back', on: !mine().readBack });
  };

  loui.on('chat', (e) => {
    if (e.type === 'start') {
      hushed = false;
      prose = null;
    } else if (e.type === 'text-start') {
      if (prose) read(prose, true);
      prose = { text: '', at: 0, fence: false };
    } else if (e.type === 'text') {
      prose ??= { text: '', at: 0, fence: false };
      prose.text += e.text;
      read(prose, false);
    } else if (e.type === 'done') {
      if (prose) read(prose, true);
      prose = null;
    } else if (e.type === 'user') {
      hush(); // a new message: the old reply stops
    } else if (e.type === 'stopped' || e.type === 'reset') {
      hush(true);
    }
  });
  // Stop, or a new message: at once, without waiting to hear back from the conversation.
  $('composer').addEventListener('submit', () => hush(true), true);

  // ── dictation ─────────────────────────────────────────────────────────────
  let phase = 'idle'; // 'getting' the model, 'listening', 'writing' it down
  let take = null; // { pieces, samples, stop, timer, partial, busy } while listening and writing
  let percent = 0;
  let held = false; // Ctrl+Shift+Space is down
  let starting = false; // between a press and the microphone opening
  const LONGEST = 16000 * 60 * 5;
  const FALLBACK = "Windows' own dictation (Win+H) works in this box too.";

  function tell(text, trouble = false) {
    note.textContent = text;
    note.hidden = !text;
    note.classList.toggle('trouble', trouble);
  }

  function drawMic() {
    const usable = !!mine().dictation;
    mic.hidden = !usable;
    if (!usable) { note.hidden = true; return; }
    mic.className = phase;
    mic.setAttribute('aria-pressed', phase === 'listening');
    if (phase === 'getting') mic.textContent = `${percent}%`;
    else mic.innerHTML = MIC;
    mic.title = {
      idle: 'Dictate (or hold Ctrl+Shift+Space while you talk)',
      getting: 'Getting the speech model. This happens once.',
      listening: 'Listening. Press to stop (Esc).',
      writing: 'Writing down what you said. Press to drop it (Esc).',
    }[phase];
    mic.setAttribute('aria-label', phase === 'listening' ? 'Stop dictating' : 'Dictate');
    if (phase === 'listening') tell(take?.partial || 'Listening…');
    else if (phase === 'writing') tell(take?.partial || 'Writing it down…');
  }

  const joined = (pieces, samples) => {
    const all = new Float32Array(samples);
    let at = 0;
    for (const p of pieces) { all.set(p, at); at += p.length; }
    return all;
  };
  // Whisper writes notes like [BLANK_AUDIO] for sound that is not speech.
  const tidy = (text) => String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

  function micTrouble(e) {
    if (e?.name === 'NotFoundError') return `Loui found no microphone. ${FALLBACK}`;
    if (e?.name === 'NotAllowedError') return `Loui is not allowed to use the microphone. In Windows, check Settings › Privacy › Microphone. ${FALLBACK}`;
    return `The microphone could not be started${e?.message ? ` (${e.message})` : ''}. ${FALLBACK}`;
  }

  // byKey: started by holding Ctrl+Shift+Space, so letting go stops it.
  async function start(byKey = false) {
    if (phase !== 'idle' || starting || !mine().dictation) return;
    starting = true;
    try {
      await begin(byKey);
    } finally {
      starting = false;
    }
  }

  async function begin(byKey) {
    hush();
    tell('');
    const first = !seams.recogniser.have();
    if (first) {
      phase = 'getting';
      percent = 0;
      tell('Getting the speech model (77 MB, once). After this, dictation works offline.');
      drawMic();
    }
    try {
      await seams.recogniser.prepare((p) => { percent = p; drawMic(); });
    } catch (e) {
      phase = 'idle';
      drawMic();
      return tell(`The speech model could not be fetched: ${e.message}. Check the connection and press the microphone to try again. ${FALLBACK}`, true);
    }
    if (first) {
      // The download took a while: listening now would come as a surprise.
      phase = 'idle';
      drawMic();
      return tell('Dictation is ready. Press the microphone and talk.');
    }
    const mineTake = take = { pieces: [], samples: 0, stop: null, timer: 0, partial: '', busy: false, open: true };
    phase = 'listening';
    drawMic();
    try {
      mineTake.stop = await seams.mic.start((piece) => {
        if (!mineTake.open) return;
        mineTake.pieces.push(piece);
        mineTake.samples += piece.length;
        if (mineTake.samples >= LONGEST) stop();
      });
    } catch (e) {
      if (take !== mineTake) return;
      take = null;
      phase = 'idle';
      drawMic();
      return tell(micTrouble(e), true);
    }
    if (take !== mineTake) return void mineTake.stop(); // dropped while the microphone was starting
    if (byKey && !held) return stop();
    // What has been said so far, shown while the talking goes on (for the first twenty seconds).
    take.timer = setInterval(async () => {
      const t = mineTake;
      if (t.busy || t.samples < 16000 || t.samples > 16000 * 20) return;
      t.busy = true;
      try {
        const text = tidy(await seams.recogniser.transcribe(joined(t.pieces, t.samples)));
        if (take === t && phase === 'listening' && text) { t.partial = text; drawMic(); }
      } catch {} finally { t.busy = false; }
    }, 2000);
  }

  // Stops listening and puts what was said into the message box, where the cursor is.
  async function stop() {
    if (phase !== 'listening') return;
    const t = take;
    clearInterval(t.timer);
    phase = 'writing';
    drawMic();
    await t.stop?.();
    t.open = false;
    const finish = (text, trouble) => {
      if (take !== t) return; // dropped meanwhile
      take = null;
      phase = 'idle';
      drawMic();
      tell(text, trouble);
    };
    const audio = joined(t.pieces, t.samples);
    let loudest = 0;
    for (let i = 0; i < audio.length; i++) loudest = Math.max(loudest, Math.abs(audio[i]));
    if (audio.length < 4800 || loudest < 0.01) return finish(audio.length < 4800 ? '' : `Loui heard nothing. Is the right microphone chosen in Windows? ${FALLBACK}`);
    try {
      const text = tidy(await seams.recogniser.transcribe(audio));
      if (take !== t) return;
      if (text) insert(text);
      finish(text ? '' : 'Loui could not make out any words.');
    } catch (e) {
      finish(`Dictation did not work: ${e.message}. ${FALLBACK}`, true);
    }
  }

  // Esc, or the button, while it writes: what was said is dropped.
  function drop() {
    const t = take;
    take = null;
    clearInterval(t?.timer);
    if (t) t.open = false;
    if (phase === 'listening') t?.stop?.();
    phase = 'idle';
    drawMic();
    tell('');
  }

  // Never sent: it lands in the box for the user to read, change and send.
  function insert(text) {
    const from = box.selectionStart, to = box.selectionEnd;
    const before = box.value.slice(0, from), after = box.value.slice(to);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
    box.setRangeText(lead + text + trail, from, to, 'end');
    box.dispatchEvent(new Event('input')); // the Send button follows
    box.focus();
  }

  mic.onclick = () => {
    if (phase === 'idle') start();
    else if (phase === 'listening') stop();
    else if (phase === 'writing') drop();
  };

  const panel = $('panel');
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (phase === 'listening') { e.stopPropagation(); stop(); }
      else if (phase === 'writing') { e.stopPropagation(); drop(); }
      else if (queued > 0) hush(true);
    } else if (e.code === 'Space' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (e.repeat || held) return;
      held = true;
      start(true);
    }
  });
  // Letting go of any of the three keys, wherever the keyboard is by then.
  const release = (e) => {
    if (!held || (e.type === 'keyup' && !(e.code === 'Space' || e.key === 'Control' || e.key === 'Shift'))) return;
    held = false;
    stop();
  };
  window.addEventListener('keyup', release);
  window.addEventListener('blur', release);

  loui.on('state', () => {
    if (!mine().readBack && queued) hush();
    if (!mine().dictation && phase !== 'idle') drop();
    drawToggle();
    drawMic();
  });
  drawToggle();
  drawMic();

  return { seams };
})();
