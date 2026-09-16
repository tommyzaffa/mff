// Mono signed PCM16 in 100 ms frames. No audio is written to disk.
class MFFCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(Math.round(sampleRate / 10));
    this.offset = 0; this.energy = 0;
    this.port.onmessage = event => { if (event.data === 'flush') this.flush(); };
  }
  flush() {
    if (!this.offset) return;
    const audio = this.frame.slice(0, this.offset).buffer;
    const level = Math.sqrt(this.energy / this.offset);
    this.port.postMessage({ audio, level }, [audio]);
    this.offset = 0; this.energy = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      value = Math.max(-1, Math.min(1, value / channels.length));
      this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.energy += value * value;
      if (this.offset === this.frame.length) this.flush();
    }
    // Output remains silent; never feed the microphone back into the PA.
    return true;
  }
}
registerProcessor('mff-capture', MFFCapture);
