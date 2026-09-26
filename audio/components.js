// Turns a scan (see spectral-processor.js) into a list of constant sounds the
// user can pick, and turns a selection back into what the filter needs.
//
// Two kinds of constant sound are reported:
//  - Broadband: the noise floor split into three ranges (rumble, low/mid
//    background noise, hiss). Removed with a fixed spectral profile.
//  - Tonal: narrow peaks that were present during the whole scan (mains hum
//    and its harmonics, a whine, a steady beep). Removed with notch filters.
//
// Levels are RMS in dBFS (0 dB = a full-scale square wave; a full-scale sine is -3 dB).

export const BANDS = [
  { id: 'band-rumble', band: 'rumble', lo: 0, hi: 200 },
  { id: 'band-low', band: 'low', lo: 200, hi: 2000 },
  { id: 'band-hiss', band: 'hiss', lo: 2000, hi: Infinity },
];

const BAND_MIN_DB = -75;     // quieter broadband floors aren't worth listing
const TONE_MIN_DB = -80;     // quieter tones aren't worth listing
const TONE_PROMINENCE = 10;  // dB above the surrounding floor
const TONE_MEDIAN_HALF = 16; // bands on each side used for the local floor
const MAX_TONES = 8;
const MAINS = [50, 60];

const toDb = (p) => 10 * Math.log10(p + 1e-30);

function median(values) {
  const a = Float64Array.from(values).sort();
  return a[a.length >> 1];
}

function bandRange(band, fftN, fs) {
  const hz = fs / fftN;
  const last = fftN / 2;
  const k0 = Math.max(0, Math.round(band.lo / hz));
  const k1 = band.hi === Infinity ? last : Math.min(last, Math.round(band.hi / hz) - 1);
  return [k0, k1];
}

// Bands right next to a detected tone are skipped: the tone raises them (and the
// floor estimate treats a steady tone like noise, which overshoots), so they'd
// make a hum show up a second time as "rumble". The rest of the range stands in
// for them; a range fully covered by tones isn't listed.
function findBands(scan, tones) {
  const { fftN, sampleRate: fs, env, median: med } = scan;
  const hz = fs / fftN;
  // With a Hann window a band of power P holds σ² · N · 0.5, and σ² is spread
  // over N/2 bands, so a range's share of the total power is Σ P / (N/2 · N · 0.5).
  const norm = (fftN / 2) * fftN * 0.5;
  const near = new Set();
  for (const t of tones) {
    for (const f of t.freqs) {
      const k = f / hz;
      for (let d = Math.floor(k - 2); d <= Math.ceil(k + 2); d++) near.add(d);
    }
  }
  const out = [];
  for (const b of BANDS) {
    const [k0, k1] = bandRange(b, fftN, fs);
    let sumFloor = 0;
    let sumContent = 0;
    let used = 0;
    for (let k = k0; k <= k1; k++) {
      if (near.has(k)) continue;
      sumFloor += env[k];
      sumContent += med[k];
      used++;
    }
    if (!used) continue;
    const scale = (k1 - k0 + 1) / used;
    const levelDb = toDb((sumFloor * scale) / norm);
    if (levelDb < BAND_MIN_DB) continue;
    out.push({
      id: b.id,
      kind: 'band',
      band: b.band,
      lo: b.lo,
      hi: b.hi === Infinity ? fs / 2 : b.hi,
      levelDb,
      contentDb: toDb((sumContent * scale) / norm),
      k0,
      k1,
    });
  }
  return out;
}

// Peaks in the high-resolution "always present" spectrum.
function findPeaks(scan) {
  const S = scan.hires;
  if (!S) return [];
  const n = scan.hiresN;
  const hz = scan.sampleRate / n;
  const peaks = [];
  const j0 = Math.max(3, Math.ceil(30 / hz));
  const j1 = Math.min(S.length - 4, Math.floor(20000 / hz));
  for (let j = j0; j <= j1; j++) {
    const v = S[j];
    if (!(v > 0)) continue;
    let isMax = true;
    for (let d = -2; d <= 2 && isMax; d++) if (d && S[j + d] > v) isMax = false;
    if (!isMax || S[j - 1] === v) continue;

    const lo = Math.max(0, j - TONE_MEDIAN_HALF);
    const hi = Math.min(S.length - 1, j + TONE_MEDIAN_HALF);
    const floor = median(S.slice(lo, hi + 1));
    if (toDb(v) - toDb(floor) < TONE_PROMINENCE) continue;

    // Exact frequency: phase advance measured during the scan (see the
    // processor); falls back to parabolic interpolation on the log spectrum.
    let freq;
    const off = scan.hiresOffset?.[j];
    if (typeof off === 'number' && Math.abs(off) <= 1) {
      freq = (j + off) * hz;
    } else {
      const a = Math.log(S[j - 1] + 1e-30);
      const b = Math.log(v + 1e-30);
      const c = Math.log(S[j + 1] + 1e-30);
      const den = a - 2 * b + c;
      freq = (j + (den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0)) * hz;
    }
    // The minimum spectrum proves the tone is always there but reads low; the
    // level comes from the 20th-percentile spectrum around the peak.
    const L = scan.hiresLow;
    const peak = L ? Math.max(v, L[j - 1], L[j], L[j + 1]) : v;
    // Hann window: a sine of amplitude A peaks at |X| = A · N / 4.
    const amp = (4 * Math.sqrt(peak)) / n;
    const levelDb = 20 * Math.log10(amp / Math.SQRT2 + 1e-15);
    if (levelDb < TONE_MIN_DB) continue;
    peaks.push({ freq, levelDb });
  }
  return peaks;
}

// How far a peak may sit from an exact harmonic (peak interpolation isn't
// perfect with 11.7 Hz bands).
const tolerance = (f) => Math.max(6, f * 0.01);

function sumDb(list) {
  return toDb(list.reduce((s, x) => s + Math.pow(10, x.levelDb / 10), 0));
}

// Groups harmonic series (e.g. 60, 120, 180 Hz) into a single sound.
function groupTones(peaks) {
  let left = [...peaks].sort((a, b) => a.freq - b.freq);
  const groups = [];

  const take = (base, maxN, tol = tolerance) => {
    const members = [];
    const rest = [];
    for (const p of left) {
      const m = Math.round(p.freq / base);
      if (m >= 1 && m <= maxN && Math.abs(p.freq - m * base) <= tol(p.freq, m)) members.push({ ...p, n: m });
      else rest.push(p);
    }
    return { members, rest };
  };

  // Mains hum first (50 or 60 Hz, whichever explains more peaks). Its
  // fundamental is sometimes missing, so the series is matched directly, but a
  // low harmonic (1st to 3rd) must be there.
  let best = null;
  for (const base of MAINS) {
    // Low mains harmonics get a looser match: they sit in the voice range,
    // where the measured frequency can be pulled a few Hz, and are rebuilt as
    // exact multiples below anyway. Higher ones must be close, or an unrelated
    // tone (say 1000 Hz, near 17 x 60) would be swallowed.
    const t = take(base, 20, (f, m) => (m <= 6 ? Math.max(8, f * 0.02) : Math.max(3, f * 0.004)));
    const ok = t.members.some((m) => m.n <= 3) && (t.members.length >= 2 || t.members[0].n === 1);
    if (ok && (!best || t.members.length > best.members.length)) best = { base, ...t };
  }
  if (best) {
    // Peaks near voice or music can be pulled a few Hz off, so the notch
    // frequencies are rebuilt as exact multiples of the fundamental (measured
    // directly when present, since the 1st harmonic is the most reliable).
    const fund = best.members.find((m) => m.n === 1);
    let f0 = fund ? fund.freq : median(best.members.map((m) => m.freq / m.n));
    // The grid itself is very stable; snap to it when the estimate is that close.
    if (Math.abs(f0 - best.base) < 0.6) f0 = best.base;
    const members = best.members.map((m) => ({ ...m, freq: m.n * f0 }));
    groups.push({ kind: 'hum', f0, members });
    left = best.rest;
  }

  // Any other harmonic series, then single tones.
  while (left.length) {
    const first = left[0];
    const { members, rest } = take(first.freq, 20);
    if (members.length >= 2) {
      groups.push({ kind: 'tone', f0: first.freq, members });
      left = rest;
    } else {
      groups.push({ kind: first.freq >= 8000 ? 'whine' : 'tone', f0: first.freq, members: [first] });
      left = left.slice(1);
    }
  }

  return groups.map((g) => ({
    id: `${g.kind}-${Math.round(g.f0)}`,
    kind: g.kind,
    freq: g.f0,
    harmonics: g.members.length - 1,
    freqs: g.members.map((m) => m.freq),
    levelDb: sumDb(g.members),
  }));
}

// Every constant sound found in a scan, loudest first.
export function analyze(scan) {
  if (!scan?.env) return [];
  const tones = groupTones(findPeaks(scan))
    .sort((a, b) => b.levelDb - a.levelDb)
    .slice(0, MAX_TONES);
  return [...findBands(scan, tones), ...tones].sort((a, b) => b.levelDb - a.levelDb);
}

// What the filter needs to remove the selected sounds: a spectral profile for
// the broadband ones (null if none) and the notch frequencies for the tonal ones.
export function compose(scan, selectedIds, components = analyze(scan)) {
  const selected = new Set(selectedIds);
  let profile = null;
  const notches = [];
  for (const c of components) {
    if (!selected.has(c.id)) continue;
    if (c.kind === 'band') {
      profile ??= new Array(scan.fftN / 2 + 1).fill(0);
      for (let k = c.k0; k <= c.k1; k++) profile[k] = scan.env[k];
    } else {
      notches.push(...c.freqs);
    }
  }
  return { profile, notches };
}
