// Audio-driven mouth movement shared by both avatar kinds.
// It follows loudness and spectral balance of the reply audio — it does not understand words.
export class LipSync {
  constructor() {
    this.level = 0;          // smoothed mouth openness 0..1
    this.bands = [0, 0, 0];  // low / mid / high energy
    this.analyser = null;
  }

  attach(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
  }

  update(speaking) {
    if (!this.analyser || !speaking) { this.level *= 0.8; return; }
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) sum += v * v;
    const rms = Math.sqrt(sum / this.time.length);
    const target = Math.min(1, Math.max(0, (rms - 0.01) * 7));
    this.level += (target - this.level) * (target > this.level ? 0.55 : 0.3);

    this.analyser.getByteFrequencyData(this.freq);
    const hz = this.analyser.context.sampleRate / this.analyser.fftSize;
    const band = (a, b) => { let s = 0, n = 0; for (let i = Math.floor(a / hz); i < Math.floor(b / hz); i++) { s += this.freq[i]; n++; } return n ? s / n / 255 : 0; };
    const raw = [band(150, 700), band(700, 1800), band(1800, 4500)];
    this.bands = this.bands.map((v, i) => v + (raw[i] - v) * 0.35);
  }

  // How "round" (o/u) vs "wide" (e/i) the current sound is: -1 wide … +1 round.
  roundness() {
    const [lo, , hi] = this.bands;
    return Math.max(-1, Math.min(1, (lo - hi) / (lo + hi + 1e-4)));
  }
}
