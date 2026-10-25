class BankVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.phase = 0; this.sum = 0; this.count = 0; this.index = 0;
    this.samples = new Int16Array(480);
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 24000;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]; this.count++; this.phase++;
      if (this.phase >= ratio) {
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.samples[this.index++] = value < 0 ? value * 32768 : value * 32767;
        this.phase -= ratio; this.sum = 0; this.count = 0;
        if (this.index === this.samples.length) {
          this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
          this.samples = new Int16Array(480); this.index = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('bank-voice-capture', BankVoiceCapture);
