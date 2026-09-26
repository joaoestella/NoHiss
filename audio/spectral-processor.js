// AudioWorklet that removes hiss by spectral subtraction.
//
// Idea: hiss is a constant sound. We split the audio into frequency
// bands (FFT) and, for each band, estimate the noise "floor" that is always
// there. Where the sound barely rises above that floor, it's hiss and the band is lowered.
// Where a voice shows up well above the floor, the band passes untouched.
//
// The noise floor comes from two sources:
//  - Automatic ("minimum statistics"): the lowest level of each band over the
//    last ~1.5 s. Reacts fast, but with speech or music that never pauses it can
//    mistake the content for noise.
//  - Learned ("Learn the hiss" button): listens for 30 s, builds a histogram
//    of each band's energy and takes a low percentile, i.e. the level that is
//    present almost all the time. Voice and music come and go; hiss stays.
//    Once learned, the automatic estimate may only move between 6 dB below
//    and the learned level itself (never above it).
//
// Digital silence (paused video, silent ad) is ignored by both;
// otherwise the noise floor would "drop to zero" and the filter would stop working.
//
// The same 30 s pass also produces a "scan" of every constant sound (see
// components.js): the per-band floor, the median level, and a high-resolution
// spectrum used to find steady tones such as mains hum or a whine. In "custom"
// mode the filter removes only the sounds picked from that scan: broadband
// ones through a fixed spectral profile, tones through narrow notch filters.

const N = 1024;               // FFT size (21 ms at 48 kHz)
const HOP = 256;              // 75% overlap
const BINS = N / 2 + 1;
const MAX_CHANNELS = 2;
const RING = 4096;
const RING_MASK = RING - 1;
const STATS_EVERY = 12000;    // 250 ms

// Learning histogram: 0.5 dB per bucket, from -160 dB to +10 dB.
const H_MIN_DB = -160;
const H_STEP_DB = 0.5;
const H_SIZE = 340;
const LEARN_PERCENTILE = 0.1;
// For Gaussian noise, each band's energy follows an exponential
// distribution; the 10th percentile sits at -ln(0.9) = 0.105 of the mean.
const LEARN_BIAS = 1 / -Math.log(1 - LEARN_PERCENTILE);

// Automatic tracker: minimum over a sliding window of SUBWIN x SUBLEN frames.
const AUTO_SMOOTH = 0.8;
const SUBWIN = 8;
const SUBLEN = 36;             // 8 x 36 frames of 5.3 ms = ~1.5 s
const AUTO_BIAS = 4.4;         // the minimum sits below the mean; calibrated with white noise
const LEARNED_FLOOR = 0.25;    // with a learned profile, go at most 6 dB lower
// A frame with energy below -90 dBFS is treated as digital silence.
const SILENCE = Math.pow(10, -90 / 10) * N * 0.5 * BINS;

const DD_ALPHA = 0.98; // "decision-directed" smoothing (less musical noise)
// Open quickly for consonants; close slowly so syllable tails don't flutter.
const GAIN_OPEN = Math.exp(-HOP / (sampleRate * 0.005));
const GAIN_CLOSE = Math.exp(-HOP / (sampleRate * 0.070));
const EPS = 1e-20;

// ---------- Radix-2 FFT (complex, in place) ----------
function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * step];
          const wi = sgn * sinT[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}
const fft = makeFFT(N);

// High-resolution analysis used only while scanning, to find steady tones:
// 4096-point FFT (11.7 Hz per band at 48 kHz) on the mono mix, 50% overlap.
// The scan is split into SCAN_BLOCKS blocks of ~3 s. In each block we keep the
// per-band minimum over all frames, then take the median of those minimums
// across blocks. A steady tone keeps its level in every single frame, so it
// survives; voice and music drop out between syllables and notes.
// The minimum proves a tone is always there but reads low (it catches moments
// where other sound cancels it), so the 20th percentile of each block is kept
// too, to measure how loud each tone is. The exact frequency comes from how
// much each band's phase advances between frames, averaged over the scan
// (phase-vocoder style), which is far more precise than the 11.7 Hz bands.
// Only quiet frames count (close to the previous block's 20th percentile), so a
// voice passing through the same band doesn't pull the estimate.
const HR_N = 4096;
const HR_HOP = 2048;
const HR_BINS = HR_N / 2 + 1;
const SCAN_BLOCKS = 10;
const fftHr = makeFFT(HR_N);
const hrWin = new Float32Array(HR_N);
for (let i = 0; i < HR_N; i++) hrWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HR_N);
const HR_SILENCE = Math.pow(10, -90 / 10) * HR_N * 0.375 * HR_BINS;

// RBJ notch biquad for one frequency; bandwidth grows slowly with frequency
// (3 Hz at 60 Hz, 0.4% of the frequency higher up): the scan measures the
// frequency precisely, and a narrow notch takes as little voice as possible.
function notchCoefs(freq) {
  const bw = Math.max(3, freq * 0.004);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * (freq / bw));
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * cw) / a0, b2: 1 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

// Square-root Hann window (analysis and synthesis). Hann at 75% overlap
// sums to 2, so the output is scaled by 0.5.
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const OLA_SCALE = 0.5;

// Profile summary for the popup: level in dBFS and a curve (dB per frequency,
// log scale from 50 Hz to 20 kHz) to draw the hiss "fingerprint".
// With a Hann window, E[|X_k|²] = σ² · N · 0.5, so σ² = mean(P) / (N · 0.5).
function summarize(p) {
  const toSampleDb = (pk) => 10 * Math.log10(pk / (N * 0.5) + EPS);
  let sum = 0;
  for (let k = 1; k < BINS; k++) sum += p[k];
  const levelDb = toSampleDb(sum / (BINS - 1));

  const POINTS = 48;
  const curve = [];
  const hzPerBin = sampleRate / N;
  for (let i = 0; i < POINTS; i++) {
    const f0 = 50 * Math.pow(400, i / POINTS);
    const f1 = 50 * Math.pow(400, (i + 1) / POINTS);
    const k0 = Math.max(1, Math.floor(f0 / hzPerBin));
    const k1 = Math.min(BINS - 1, Math.max(k0, Math.ceil(f1 / hzPerBin)));
    let s = 0;
    for (let k = k0; k <= k1; k++) s += p[k];
    curve.push(toSampleDb(s / (k1 - k0 + 1)));
  }
  return { levelDb, curve };
}

// Hiss is "smooth" across the spectrum; voice and music are made of harmonics,
// narrow peaks with valleys between them. So that a long note or background
// music doesn't end up in the profile as noise, the final profile is the "lower
// envelope": for each band, take the 30th percentile of the neighboring bands
// (±1/6 octave). For hiss this barely changes anything; on harmonics,
// the profile drops to the level of the valleys, which is where the real noise is.
const ENV_Q = 0.3;
const envBuf = new Float32Array(BINS);
const envLo = new Int32Array(BINS);
const envHi = new Int32Array(BINS);
for (let k = 0; k < BINS; k++) {
  const half = Math.max(2, Math.round(k * (Math.pow(2, 1 / 6) - 1)));
  envLo[k] = Math.max(0, k - half);
  envHi[k] = Math.min(BINS - 1, k + half);
}
function lowerEnvelope(src, dst) {
  for (let k = 0; k < BINS; k++) {
    const n = envHi[k] - envLo[k] + 1;
    const arr = envBuf.subarray(0, n);
    arr.set(src.subarray(envLo[k], envHi[k] + 1));
    arr.sort();
    const v = arr[Math.floor((n - 1) * ENV_Q)];
    dst[k] = v < src[k] ? v : src[k];
  }
}

// Value (linear power) at a given rank of one band's learning histogram.
function histPercentile(hist, k, target) {
  let cum = 0;
  let h = 0;
  const base = k * H_SIZE;
  for (; h < H_SIZE; h++) {
    cum += hist[base + h];
    if (cum >= target) break;
  }
  return Math.pow(10, (H_MIN_DB + (h + 0.5) * H_STEP_DB) / 10);
}

class ChannelState {
  constructor() {
    this.frame = new Float32Array(N);   // last N input samples
    this.acc = new Float32Array(N);     // overlap-add accumulator
    this.smooth = new Float32Array(BINS);
    // Minimums: current sub-block, previous sub-blocks, and the combined one.
    // They start "at the ceiling" so the first non-silent frame sets the level.
    this.subMin = new Float32Array(BINS).fill(1e12);
    this.winMins = new Float32Array(SUBWIN * BINS).fill(1e12);
    this.pastMin = new Float32Array(BINS).fill(1e12);
    this.minTrack = new Float32Array(BINS).fill(1e12);
    this.subCount = 0;
    this.subSlot = 0;
    this.started = false;
    this.histCount = 0;
    this.autoNoise = new Float32Array(BINS).fill(1e-6); // lower envelope of minTrack
    this.noiseEst = new Float32Array(BINS);
    this.gPrev = new Float32Array(BINS).fill(1);
    this.gammaPrev = new Float32Array(BINS).fill(1);
    this.appliedGain = new Float32Array(BINS).fill(1);
    this.hist = null;
  }
}

class SpectralProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0 = remove nothing, 1 = lower individual bands by up to 18 dB.
      { name: 'amount', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.ch = [new ChannelState(), new ChannelState()];
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.gain = new Float32Array(BINS);
    this.gainSm = new Float32Array(BINS);

    this.out = [new Float32Array(RING), new Float32Array(RING)];
    this.dryOut = [new Float32Array(RING), new Float32Array(RING)];
    this.inCount = 0;          // new samples since the last frame
    this.writeIdx = HOP;       // start with HOP samples of silence queued
    this.readIdx = 0;
    this.queued = HOP;

    this.learned = null;       // [Float32Array(BINS) per channel]
    this.learning = null;      // { framesTotal, framesDone }
    this.hr = null;            // high-resolution scan accumulator (only while learning)
    // Custom mode: { profile: Float32Array(BINS) | null, notches: [biquad] }.
    this.custom = null;
    this.channels = 1;
    this.frameCount = 0;

    this.statSamples = 0;
    this.statIn = 0;
    this.statOut = 0;
    this.statNoise = 0;
    this.statNoiseLeft = 0;
    this.statNoiseEst = 0;
    this.statFrames = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg?.type === 'learn') {
      const seconds = msg.seconds || 30;
      for (const c of this.ch) { c.hist = new Uint32Array(BINS * H_SIZE); c.histCount = 0; }
      this.learning = { framesTotal: Math.round((seconds * sampleRate) / HOP), framesDone: 0 };
      this.hr = {
        frame: new Float32Array(HR_N),
        re: new Float64Array(HR_N),
        im: new Float64Array(HR_N),
        count: 0,
        blockFrames: 0,
        framesSeen: 0,
        framesPerBlock: Math.max(1, Math.ceil((seconds * sampleRate) / HR_HOP / SCAN_BLOCKS)),
        store: null,           // this block's frames: framesPerBlock x HR_BINS
        prevRe: new Float64Array(HR_BINS),
        prevIm: new Float64Array(HR_BINS),
        prevOk: false,
        prevP: new Float64Array(HR_BINS),
        advRe: new Float64Array(HR_BINS), // Σ X_t · conj(X_t-1), per band
        advIm: new Float64Array(HR_BINS),
        lastLow: null,         // previous block's 20th percentile
        blocks: [],            // per-block minimum
        lows: [],              // per-block 20th percentile
      };
      this.port.postMessage({ type: 'learn-progress', progress: 0 });
    } else if (msg?.type === 'cancel-learn') {
      this.learning = null;
      this.hr = null;
      for (const c of this.ch) c.hist = null;
    } else if (msg?.type === 'set-custom') {
      // Sounds picked from the scan. active=false goes back to the normal filter.
      this.custom = msg.active
        ? {
            profile: msg.profile ? Float32Array.from(msg.profile) : null,
            notches: (msg.notches || []).map((f) => ({ ...notchCoefs(f), z: [[0, 0], [0, 0]] })),
          }
        : null;
    } else if (msg?.type === 'forget') {
      this.learned = null;
      this.port.postMessage({ type: 'learned', profile: null });
    } else if (msg?.type === 'set-profile') {
      // Profile saved from a previous session.
      this.learned = msg.profile ? msg.profile.map((p) => Float32Array.from(p)) : null;
    }
  }

  finishLearning() {
    // If almost everything was silence (paused video), there is nothing to learn.
    if (this.ch[0].histCount < this.learning.framesTotal * 0.2) {
      for (const c of this.ch) { c.hist = null; c.histCount = 0; }
      this.learning = null;
      this.hr = null;
      this.port.postMessage({ type: 'learn-failed', reason: 'silence' });
      return;
    }
    const profiles = [];
    const floors = [];
    const medians = [];
    for (let c = 0; c < MAX_CHANNELS; c++) {
      const st = this.ch[c];
      if (c > 0 && st.histCount === 0) {
        // Mono audio: the second channel uses the same profile.
        profiles.push(Float32Array.from(profiles[0]));
        st.hist = null;
        continue;
      }
      const prof = new Float32Array(BINS);
      const median = new Float32Array(BINS);
      const total = st.histCount;
      for (let k = 0; k < BINS; k++) {
        prof[k] = histPercentile(st.hist, k, total * LEARN_PERCENTILE) * LEARN_BIAS;
        // Median of an exponential distribution = ln 2 x mean.
        median[k] = histPercentile(st.hist, k, total * 0.5) / Math.LN2;
      }
      // Light smoothing across neighboring bands.
      const sm = new Float32Array(BINS);
      for (let k = 0; k < BINS; k++) {
        const a = prof[Math.max(0, k - 1)];
        const b = prof[Math.min(BINS - 1, k + 1)];
        sm[k] = 0.25 * a + 0.5 * prof[k] + 0.25 * b;
      }
      lowerEnvelope(sm, prof);
      profiles.push(prof);
      floors.push(sm);
      medians.push(median);
      st.hist = null;
      st.histCount = 0;
    }
    this.learned = profiles;
    this.learning = null;

    const avg = (list) => {
      const out = new Array(BINS);
      for (let k = 0; k < BINS; k++) {
        let v = 0;
        for (const a of list) v += a[k];
        out[k] = v / list.length;
      }
      return out;
    };
    const scan = {
      sampleRate,
      fftN: N,
      hiresN: HR_N,
      floor: avg(floors),      // 10th percentile per band (constant part of the sound)
      env: avg(profiles.slice(0, floors.length)), // floor without narrow peaks
      median: avg(medians),    // typical level per band (content)
    };
    const hires = this.finishScan();
    scan.hires = hires ? hires.min : null;    // "present in every frame" spectrum
    scan.hiresLow = hires ? hires.low : null; // 20th percentile, for tone levels
    scan.hiresOffset = hires ? hires.offset : null; // exact frequency offset per band

    this.port.postMessage({
      type: 'learned',
      profile: profiles.map((x) => Array.from(x)),
      scan,
      ...summarize(profiles[0]),
    });
  }

  // ---------- High-resolution scan (tones) ----------
  scanSample(x) {
    const hr = this.hr;
    hr.frame[HR_N - HR_HOP + hr.count] = x;
    if (++hr.count < HR_HOP) return;
    hr.count = 0;

    const { re, im } = hr;
    for (let i = 0; i < HR_N; i++) { re[i] = hr.frame[i] * hrWin[i]; im[i] = 0; }
    hr.frame.copyWithin(0, HR_HOP);
    fftHr(re, im, false);
    let energy = 0;
    for (let k = 0; k < HR_BINS; k++) energy += re[k] * re[k] + im[k] * im[k];
    if (energy >= HR_SILENCE) {
      hr.store ??= new Float32Array(hr.framesPerBlock * HR_BINS);
      const base = hr.blockFrames * HR_BINS;
      const low = hr.lastLow;
      for (let k = 0; k < HR_BINS; k++) {
        const P = re[k] * re[k] + im[k] * im[k];
        hr.store[base + k] = P;
        if (hr.prevOk && low && P <= 3 * low[k] && hr.prevP[k] <= 3 * low[k]) {
          hr.advRe[k] += re[k] * hr.prevRe[k] + im[k] * hr.prevIm[k];
          hr.advIm[k] += im[k] * hr.prevRe[k] - re[k] * hr.prevIm[k];
        }
        hr.prevP[k] = P;
      }
      hr.prevRe.set(re.subarray(0, HR_BINS));
      hr.prevIm.set(im.subarray(0, HR_BINS));
      hr.prevOk = true;
      hr.blockFrames++;
    } else {
      hr.prevOk = false;
    }
    if (++hr.framesSeen % hr.framesPerBlock === 0) this.closeScanBlock();
  }

  closeScanBlock() {
    const hr = this.hr;
    // A block that was mostly silence says nothing about what is constant.
    const n = hr.blockFrames;
    if (n >= hr.framesPerBlock * 0.5) {
      const min = new Float64Array(HR_BINS);
      const low = new Float64Array(HR_BINS);
      const col = new Float32Array(n);
      for (let k = 0; k < HR_BINS; k++) {
        for (let f = 0; f < n; f++) col[f] = hr.store[f * HR_BINS + k];
        col.sort();
        min[k] = col[0];
        low[k] = col[Math.floor((n - 1) * 0.2)];
      }
      hr.blocks.push(min);
      hr.lows.push(low);
      hr.lastLow = low;
    }
    hr.blockFrames = 0;
  }

  finishScan() {
    const hr = this.hr;
    if (!hr) return null;
    if (hr.blockFrames >= hr.framesPerBlock * 0.5) this.closeScanBlock();
    this.hr = null;
    if (hr.blocks.length < 2) return null;
    const medianOf = (list) => {
      const out = new Array(HR_BINS);
      const tmp = new Float64Array(list.length);
      for (let k = 0; k < HR_BINS; k++) {
        for (let b = 0; b < list.length; b++) tmp[b] = list[b][k];
        tmp.sort();
        out[k] = tmp[tmp.length >> 1];
      }
      return out;
    };
    // Frequency offset of each band, in bands: with hop = N/2, a band's centre
    // advances by π·k per frame; the extra advance gives the true frequency.
    const offset = new Array(HR_BINS);
    for (let k = 0; k < HR_BINS; k++) {
      let d = Math.atan2(hr.advIm[k], hr.advRe[k]) - Math.PI * k;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      offset[k] = d / Math.PI;
    }
    return { min: medianOf(hr.blocks), low: medianOf(hr.lows), offset };
  }

  // Minimum statistics: keeps the minimum of each sub-block of SUBLEN frames
  // and uses the lowest of the last SUBWIN sub-blocks (~1.5 s).
  trackMinimum(st, re, im) {
    for (let k = 0; k < BINS; k++) {
      const P = re[k] * re[k] + im[k] * im[k];
      const s = (st.smooth[k] = AUTO_SMOOTH * st.smooth[k] + (1 - AUTO_SMOOTH) * P);
      if (s < st.subMin[k]) st.subMin[k] = s;
      st.minTrack[k] = st.subMin[k] < st.pastMin[k] ? st.subMin[k] : st.pastMin[k];
    }
    if (++st.subCount < SUBLEN) return;

    // Close the sub-block: store it in the ring and recompute the previous minimum.
    st.winMins.set(st.subMin, st.subSlot * BINS);
    st.subSlot = (st.subSlot + 1) % SUBWIN;
    st.subCount = 0;
    st.subMin.fill(1e12);
    for (let k = 0; k < BINS; k++) {
      let m = 1e12;
      for (let j = 0; j < SUBWIN; j++) {
        const v = st.winMins[j * BINS + k];
        if (v < m) m = v;
      }
      st.pastMin[k] = m;
    }
  }

  processFrame(channels, amount, bypass) {
    const floor = Math.pow(10, (-18 * amount) / 20);
    const over = 1 + 0.25 * amount;
    const re = this.re;
    const im = this.im;
    const learning = this.learning;
    const w = this.writeIdx;

    for (let c = 0; c < channels; c++) {
      const st = this.ch[c];
      const frame = st.frame;
      for (let i = 0; i < N; i++) { re[i] = frame[i] * win[i]; im[i] = 0; }
      fft(re, im, false);

      let energy = 0;
      for (let k = 0; k < BINS; k++) energy += re[k] * re[k] + im[k] * im[k];
      const silent = energy < SILENCE;

      if (!silent && !st.started) {
        for (let k = 0; k < BINS; k++) st.smooth[k] = re[k] * re[k] + im[k] * im[k];
        st.started = true;
      }
      if (!silent) this.trackMinimum(st, re, im);
      if (learning && !silent) st.histCount++;

      const noise = this.learned ? this.learned[c] : null;
      const custom = this.custom;
      if ((this.frameCount & 15) === 0) lowerEnvelope(st.minTrack, st.autoNoise);
      for (let k = 0; k < BINS; k++) {
        const P = re[k] * re[k] + im[k] * im[k];

        if (learning && !silent) {
          let h = Math.floor((10 * Math.log10(P + EPS) - H_MIN_DB) / H_STEP_DB);
          if (h < 0) h = 0; else if (h >= H_SIZE) h = H_SIZE - 1;
          st.hist[k * H_SIZE + h]++;
        }

        if (bypass) { this.gain[k] = 1; st.noiseEst[k] = 0; continue; }

        let est;
        if (custom) {
          // Custom mode: remove exactly the picked broadband sounds, nothing else.
          if (!custom.profile) { this.gain[k] = 1; st.noiseEst[k] = 0; continue; }
          est = custom.profile[k];
        } else {
          // With a learned profile, it acts as a ceiling: continuous voice or
          // music doesn't "turn into" noise over time.
          est = st.autoNoise[k] * AUTO_BIAS;
          if (noise) {
            const hi = noise[k];
            const lo = hi * LEARNED_FLOOR;
            est = est > hi ? hi : est < lo ? lo : est;
          }
        }
        st.noiseEst[k] = est;
        const Nk = est * over + EPS;
        const gamma = P / Nk;
        let xi = DD_ALPHA * st.gPrev[k] * st.gPrev[k] * st.gammaPrev[k]
          + (1 - DD_ALPHA) * Math.max(gamma - 1, 0);
        // The recursive estimate alone can miss a short consonant after a
        // pause. Recover promptly only when energy rises above the noise.
        if (gamma > 3 && gamma > 2 * st.gammaPrev[k]) {
          xi = Math.max(xi, 0.5 * (gamma - 1));
        }
        let g = xi / (1 + xi);
        st.gPrev[k] = g;
        st.gammaPrev[k] = Math.min(gamma, 1e6);
        this.gain[k] = g < floor ? floor : g;
      }

      // Smooth the gain across neighboring bands (reduces "musical noise").
      const G = this.gainSm;
      for (let k = 0; k < BINS; k++) {
        const a = this.gain[k > 0 ? k - 1 : 0];
        const b = this.gain[k < BINS - 1 ? k + 1 : BINS - 1];
        const target = 0.25 * a + 0.5 * this.gain[k] + 0.25 * b;
        const previous = st.appliedGain[k];
        const smoothing = target > previous ? GAIN_OPEN : GAIN_CLOSE;
        // An empty custom band must stay transparent, including after edits.
        const transparent = bypass || amount === 0 || (custom && !custom.profile?.[k]);
        G[k] = transparent ? 1 : smoothing * previous + (1 - smoothing) * target;
        st.appliedGain[k] = G[k];
      }
      if (c === 0 && !silent) {
        // How much of the estimated hiss is being removed (for the meter).
        for (let k = 1; k < BINS; k++) {
          const nk = st.noiseEst[k];
          this.statNoise += nk;
          this.statNoiseEst += nk;
          this.statNoiseLeft += nk * G[k] * G[k];
        }
        this.statFrames++;
      }
      for (let k = 0; k < BINS; k++) {
        re[k] *= G[k]; im[k] *= G[k];
        if (k > 0 && k < N / 2) { re[N - k] *= G[k]; im[N - k] *= G[k]; }
      }

      fft(re, im, true);

      // Overlap-add; the first HOP samples are now final.
      const acc = st.acc;
      for (let i = 0; i < N; i++) acc[i] += (re[i] / N) * win[i] * OLA_SCALE;
      const out = this.out[c];
      const dry = this.dryOut[c];
      for (let i = 0; i < HOP; i++) {
        const idx = (w + i) & RING_MASK;
        out[idx] = acc[i];
        // Original signal with the same delay as the processed output (for the meter).
        dry[idx] = frame[i];
      }
      acc.copyWithin(0, HOP);
      acc.fill(0, N - HOP);
    }

    this.writeIdx = (w + HOP) & RING_MASK;
    this.queued += HOP;
    this.frameCount++;

    if (learning) {
      learning.framesDone++;
      if (learning.framesDone % 94 === 0) {
        this.port.postMessage({ type: 'learn-progress', progress: learning.framesDone / learning.framesTotal });
      }
      if (learning.framesDone >= learning.framesTotal) this.finishLearning();
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;

    // No input connected (the other mode is active): don't burn CPU.
    if (input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    const channels = input.length >= 2 ? 2 : 1;
    this.channels = channels;
    const amount = parameters.amount[0];
    const bypass = parameters.bypass[0] >= 0.5;

    const notches = !bypass && this.custom ? this.custom.notches : null;
    for (let i = 0; i < n; i++) {
      if (this.hr) this.scanSample(channels === 2 ? 0.5 * (input[0][i] + input[1][i]) : input[0][i]);
      for (let c = 0; c < channels; c++) {
        let x = input[c][i];
        if (notches) {
          // Picked tones (hum, whine): cascaded notch filters, before the FFT stage.
          for (const q of notches) {
            const z = q.z[c];
            const y = q.b0 * x + z[0];
            z[0] = q.b1 * x - q.a1 * y + z[1];
            z[1] = q.b2 * x - q.a2 * y;
            x = y;
          }
        }
        const f = this.ch[c].frame;
        // Sliding window: shifts by HOP (below), writes at the end.
        f[N - HOP + this.inCount] = x;
      }
      if (++this.inCount === HOP) {
        this.processFrame(channels, amount, bypass);
        for (let c = 0; c < channels; c++) this.ch[c].frame.copyWithin(0, HOP);
        this.inCount = 0;
      }
    }

    if (this.queued < n) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    let r = this.readIdx;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < output.length; c++) {
        const src = Math.min(c, channels - 1);
        const v = this.out[src][r];
        output[c][i] = v;
        if (c === 0) {
          const d = this.dryOut[src][r];
          this.statIn += d * d;
          this.statOut += v * v;
        }
      }
      r = (r + 1) & RING_MASK;
    }
    this.readIdx = r;
    this.queued -= n;

    this.statSamples += n;
    if (this.statSamples >= STATS_EVERY) {
      const toDb = (e) => 10 * Math.log10(e / this.statSamples + 1e-12);
      const inputDb = toDb(this.statIn);
      const outputDb = toDb(this.statOut);
      this.port.postMessage({
        type: 'stats',
        inputDb,
        outputDb,
        reductionDb: inputDb < -70 ? 0 : Math.max(0, inputDb - outputDb),
        noiseReductionDb: this.statNoise > 0
          ? 10 * Math.log10(this.statNoise / (this.statNoiseLeft + EPS))
          : 0,
        // Current estimated hiss level (dBFS).
        noiseLevelDb: 10 * Math.log10(this.statNoiseEst / ((BINS - 1) * this.statFrames * N * 0.5 + EPS) + EPS),
        vad: null,
        ready: true,
      });
      this.statNoiseEst = 0;
      this.statFrames = 0;
      this.statSamples = 0;
      this.statIn = 0;
      this.statOut = 0;
      this.statNoise = 0;
      this.statNoiseLeft = 0;
    }
    return true;
  }
}

registerProcessor('spectral-processor', SpectralProcessor);
