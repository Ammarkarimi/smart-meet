// Voice-activity-aware chunked recorder. Cuts a MediaStream into standalone
// webm/opus files at natural pauses so each chunk can be transcribed on its own.

const MIME = 'audio/webm;codecs=opus';

export class ChunkedRecorder {
  /**
   * @param {MediaStream} stream
   * @param {object} opts
   * @param {AudioContext} opts.audioContext
   * @param {number} opts.minMs   don't cut before this much audio
   * @param {number} opts.maxMs   always cut after this much audio
   * @param {number} opts.silenceMs  cut once this much trailing silence follows speech
   * @param {(blob: Blob, info: {startedAt: number, endedAt: number, speechMs: number}) => void} opts.onChunk
   */
  constructor(stream, { audioContext, minMs = 6000, maxMs = 20000, silenceMs = 800, onChunk }) {
    this.stream = stream;
    this.ctx = audioContext;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.silenceMs = silenceMs;
    this.onChunk = onChunk;
    this.noiseFloor = 0.003;
    this.recorder = null;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.#newRecorder();
    this.timer = setInterval(() => this.#tick(), 100);
  }

  #newRecorder() {
    const rec = new MediaRecorder(this.stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
    const parts = [];
    const info = { startedAt: Date.now(), speechMs: 0, lastSpeechAt: 0 };
    rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: MIME });
      // Skip chunks that are basically silence: saves API cost and avoids hallucinated text.
      if (info.speechMs >= 400 && blob.size > 1000) {
        this.onChunk(blob, { startedAt: info.startedAt, endedAt: info.endedAt || Date.now(), speechMs: info.speechMs });
      }
    };
    rec.start();
    this.recorder = rec;
    this.info = info;
  }

  #level() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    return Math.sqrt(sum / this.samples.length);
  }

  #tick() {
    const now = Date.now();
    const rms = this.#level();
    const threshold = Math.max(0.008, this.noiseFloor * 3);
    const speaking = rms > threshold;
    // Slowly track the noise floor while quiet; adapt quickly downward.
    if (!speaking) this.noiseFloor = rms < this.noiseFloor ? rms * 0.5 + this.noiseFloor * 0.5 : this.noiseFloor * 0.98 + rms * 0.02;
    const info = this.info;
    if (speaking) {
      info.speechMs += 100;
      info.lastSpeechAt = now;
    }
    const elapsed = now - info.startedAt;
    const pausedAfterSpeech = info.speechMs > 0 && now - info.lastSpeechAt >= this.silenceMs;
    if (elapsed >= this.maxMs || (elapsed >= this.minMs && pausedAfterSpeech)) this.#cut();
  }

  #cut() {
    const old = this.recorder;
    this.info.endedAt = Date.now();
    this.#newRecorder();
    if (old.state !== 'inactive') old.stop();
  }

  /** Stops recording; resolves once the final chunk has been handed to onChunk. */
  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    clearInterval(this.timer);
    const rec = this.recorder;
    this.info.endedAt = Date.now();
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') { resolve(); return; }
      const prev = rec.onstop;
      rec.onstop = (e) => { prev?.call(rec, e); resolve(); };
      rec.stop();
    });
  }
}
