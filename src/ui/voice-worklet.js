// Runs on the audio thread while dictation listens: hands the microphone's
// sound to src/ui/voice.js in tenths of a second (at the context's 16 kHz).
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.piece = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const sound = inputs[0]?.[0];
    if (!sound) return true;
    for (let i = 0; i < sound.length; i++) {
      this.piece[this.filled++] = sound[i];
      if (this.filled === this.piece.length) {
        this.port.postMessage(this.piece);
        this.piece = new Float32Array(1600);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', Capture);
