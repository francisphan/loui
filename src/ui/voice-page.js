// The hidden page that turns speech into text, with a Whisper model run by
// transformers.js on WebAssembly. It is served, with the model, from
// loui-voice://app/ by src/main/voice.js, which refuses every other request
// from here: nothing this page hears can leave the machine.
// `host` is the bridge from src/main/voice-preload.js.
import { env, pipeline, Tensor } from './lib/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false; // the files are on disk already; a second copy would only cost space
env.backends.onnx.wasm.wasmPaths = new URL('lib/', location.href).href;

const MODEL = 'Xenova/whisper-base';
const SAMPLES = 16000 * 30; // what the model hears at once

let asr = null;
try {
  asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'wasm' });
  host.send({ type: 'ready' });
} catch (e) {
  host.send({ type: 'failed', text: e?.message || String(e) });
}

// Which of the given languages is being spoken: the one the model thinks most
// likely for the first half minute. One language given: that one, unasked.
// (transformers.js does not pick the language itself: left alone it assumes English.)
async function languageOf(audio, languages) {
  const ids = asr.model.generation_config.lang_to_id || {};
  const known = languages.filter((l) => ids[`<|${l}|>`] !== undefined);
  if (known.length < 2) return known[0] || 'en';
  const { input_features } = await asr.processor(audio.subarray(0, SAMPLES));
  const start = asr.model.generation_config.decoder_start_token_id;
  const { logits } = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', [BigInt(start)], [1, 1]) });
  const scores = logits.data;
  return known.reduce((best, l) => (scores[ids[`<|${l}|>`]] > scores[ids[`<|${best}|>`]] ? l : best));
}

// One at a time, in the order asked.
let line = Promise.resolve();
host.on(({ id, audio, languages }) => {
  line = line.then(async () => {
    try {
      const began = performance.now();
      const language = await languageOf(audio, languages);
      const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
      host.send({ type: 'text', id, text: out.text.trim(), language, ms: Math.round(performance.now() - began) });
    } catch (e) {
      host.send({ type: 'failed', id, text: e?.message || String(e) });
    }
  });
});
