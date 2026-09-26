// AudioWorklet that removes noise with RNNoise (the Xiph/Mozilla neural network,
// compiled to WebAssembly by the Jitsi project).
//
// Web Audio delivers blocks of 128 samples, but RNNoise works on frames
// of 480 samples (10 ms at 48 kHz). So the processor buffers the incoming
// samples, runs RNNoise every 480 of them and returns the result.
//
// Total latency: 30 ms = 10 ms of that buffer + 20 ms inside RNNoise
// (it looks two frames back before returning audio). The original
// ("dry") signal is delayed by exactly the same amount, so both can be
// mixed (the strength control) without an echo/comb-filter effect.

import createRNNWasmModuleSync from './vendor/rnnoise-sync.js';

const FRAME = 480;          // RNNoise frame size
const SCALE = 32768;        // RNNoise expects samples on a 16-bit scale
const MAX_CHANNELS = 2;
const RING = 4096;          // power of 2, far larger than needed
const RING_MASK = RING - 1;
const STATS_EVERY = 12000;  // post stats every 250 ms
const RNN_DELAY_FRAMES = 2; // RNNoise internal delay (measured: 960 samples)
const HISTORY = RNN_DELAY_FRAMES + 1;

class RnnoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' }];
  }

  constructor() {
    super();
    this.ready = false;

    try {
      this.wasm = createRNNWasmModuleSync();
      this.states = [];
      this.ptrs = [];
      for (let c = 0; c < MAX_CHANNELS; c++) {
        this.states.push(this.wasm._rnnoise_create(0));
        this.ptrs.push(this.wasm._malloc(FRAME * 4));
      }
      this.ready = true;
    } catch (err) {
      this.port.postMessage({ type: 'error', message: `RNNoise failed to load: ${err}` });
    }

    this.inFrame = [];
    this.history = []; // last input frames, used to delay the dry signal
    this.dry = [];
    this.wet = [];
    for (let c = 0; c < MAX_CHANNELS; c++) {
      this.inFrame.push(new Float32Array(FRAME));
      this.history.push(Array.from({ length: HISTORY }, () => new Float32Array(FRAME)));
      this.dry.push(new Float32Array(RING));
      this.wet.push(new Float32Array(RING));
    }
    this.histIdx = 0;
    this.inPos = 0;
    this.readIdx = 0;
    // Start with one frame of silence queued: guarantees there are always
    // samples ready for the output (that's where the fixed 10 ms delay comes from).
    this.writeIdx = FRAME;
    this.queued = FRAME;

    this.resetStats();
  }

  resetStats() {
    this.statSamples = 0;
    this.statIn = 0;
    this.statOut = 0;
    this.statVad = 0;
    this.statFrames = 0;
  }

  processFrame(channels) {
    const w = this.writeIdx;
    let vad = 0;

    const h = this.histIdx;
    const hDelayed = (h + 1) % HISTORY; // the frame from RNN_DELAY_FRAMES ago

    for (let c = 0; c < channels; c++) {
      const frame = this.inFrame[c];
      const hist = this.history[c];
      hist[h].set(frame);
      const delayed = hist[hDelayed];
      const dry = this.dry[c];
      const wet = this.wet[c];

      if (this.ready) {
        const base = this.ptrs[c] >> 2;
        let heap = this.wasm.HEAPF32;
        for (let i = 0; i < FRAME; i++) heap[base + i] = frame[i] * SCALE;
        // Process in place: input and output share the same pointer.
        const p = this.wasm._rnnoise_process_frame(this.states[c], this.ptrs[c], this.ptrs[c]);
        if (p > vad) vad = p;
        heap = this.wasm.HEAPF32; // memory may have grown
        for (let i = 0; i < FRAME; i++) {
          const idx = (w + i) & RING_MASK;
          dry[idx] = delayed[i];
          wet[idx] = heap[base + i] / SCALE;
        }
      } else {
        // Without RNNoise: pass the audio through with the same delay, unprocessed.
        for (let i = 0; i < FRAME; i++) {
          const idx = (w + i) & RING_MASK;
          dry[idx] = delayed[i];
          wet[idx] = delayed[i];
        }
      }
    }

    this.histIdx = (h + 1) % HISTORY;
    this.writeIdx = (w + FRAME) & RING_MASK;
    this.queued += FRAME;
    this.statVad += vad;
    this.statFrames++;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const inChannels = input.length;

    // Stereo runs two independent RNNoise instances; mono runs one and duplicates it.
    const channels = inChannels >= 2 ? 2 : 1;

    // 1) Input -> 480-sample frames.
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        this.inFrame[c][this.inPos] = inChannels === 0 ? 0 : input[c][i];
      }
      if (++this.inPos === FRAME) {
        this.processFrame(channels);
        this.inPos = 0;
      }
    }

    // 2) Queue -> output, mixing dry and processed.
    const mix = parameters.mix;
    const mixConst = mix.length === 1;
    let r = this.readIdx;

    if (this.queued < n) {
      // Should never happen; if it does, output silence instead of garbage.
      for (const ch of output) ch.fill(0);
      return true;
    }

    for (let i = 0; i < n; i++) {
      const m = mixConst ? mix[0] : mix[i];
      for (let c = 0; c < output.length; c++) {
        const src = Math.min(c, channels - 1);
        const d = this.dry[src][r];
        const out = d + (this.wet[src][r] - d) * m;
        output[c][i] = out;
        if (c === 0) {
          this.statIn += d * d;
          this.statOut += out * out;
        }
      }
      r = (r + 1) & RING_MASK;
    }
    this.readIdx = r;
    this.queued -= n;

    // 3) Stats for the popup meter.
    this.statSamples += n;
    if (this.statSamples >= STATS_EVERY) {
      const toDb = (e) => 10 * Math.log10(e / this.statSamples + 1e-12);
      const inputDb = toDb(this.statIn);
      const outputDb = toDb(this.statOut);
      this.port.postMessage({
        type: 'stats',
        inputDb,
        outputDb,
        // Below -70 dB it's basically silence: measuring reduction makes no sense.
        reductionDb: inputDb < -70 ? 0 : Math.max(0, inputDb - outputDb),
        vad: this.statFrames ? this.statVad / this.statFrames : 0,
        ready: this.ready,
      });
      this.resetStats();
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
