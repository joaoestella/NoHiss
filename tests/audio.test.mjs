import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { load, run, noise, rms } from './worklet-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = amplitude => Array.from({ length: 2 }, () => Array(513).fill(amplitude ** 2 * 512));
function error(output, input, delay) {
  let max = 0;
  for (let i = delay; i < output.length; i++) max = Math.max(max, Math.abs(output[i] - input[i - delay]));
  return max;
}

for (const [mode, delay] of [['spectral', 1024], ['rnnoise', 1440]]) {
  test(`${mode}: zero strength and bypass preserve stereo with fixed latency`, () => {
    const left = noise(24000, .1);
    const right = Float32Array.from(left, (v, i) => v * Math.sin(i / 33));
    for (const [amount, bypass] of [[0, false], [1, true]]) {
      const p = load(root, mode);
      if (mode === 'rnnoise') assert.equal(p.ready, true);
      const { output, outputR } = run(p, left, amount, bypass, right);
      assert.ok(error(output, left, delay) < 1e-6);
      assert.ok(error(outputR, right, delay) < 1e-6);
    }
  });
  test(`${mode}: silence stays finite and mono duplicates to stereo`, () => {
    const { output, outputR } = run(load(root, mode), new Float32Array(4800), 1);
    assert.ok(output.every(v => Number.isFinite(v) && Math.abs(v) < 1e-8));
    assert.deepEqual(output, outputR);
  });
}

test('spectral: learned hiss is reduced without suppressing synthetic syllable tails', () => {
  const clean = new Float32Array(48000 * 5);
  for (let i = 48000; i < 48000 * 4; i++) {
    const t = i / 48000, local = t % .5;
    const env = local < .28 ? Math.min(1, local / .012) * Math.min(1, (.28 - local) / .07) : 0;
    for (let k = 1; k <= 12; k++) clean[i] += .08 * env * Math.sin(2 * Math.PI * k * (170 * t + 2 * Math.sin(t * 3))) / k;
  }
  const hiss = noise(clean.length, .012);
  const noisy = Float32Array.from(clean, (v, i) => v + hiss[i]);
  const p = load(root, 'spectral');
  p.onMessage({ type: 'set-profile', profile: profile(.012) });
  const { output } = run(p, noisy, .8);
  assert.ok(output.every(Number.isFinite));
  const reduction = -20 * Math.log10(rms(output, clean.length - 20000) / .012);
  assert.ok(reduction > 8 && reduction < 18, `hiss reduction: ${reduction} dB`);
  let cross = 0, energy = 0;
  for (let i = 48000; i < 48000 * 4; i++) {
    cross += clean[i] * output[i + 1024]; energy += clean[i] ** 2;
  }
  assert.ok(cross / energy > .94, `synthetic signal gain: ${cross / energy}`);
});

test('spectral: empty custom selection remains transparent', () => {
  const p = load(root, 'spectral');
  p.onMessage({ type: 'set-custom', active: true, profile: null, notches: [] });
  const input = noise(12000, .1);
  assert.ok(error(run(p, input, 1).output, input, 1024) < 1e-6);
});

test('rnnoise: a rejected sound retains 10% of the aligned original at full strength', () => {
  const p = load(root, 'rnnoise');
  assert.equal(p.ready, true);
  // Deterministically simulate the model classifying the entire signal as noise.
  p.wasm._rnnoise_process_frame = (_state, out) => {
    p.wasm.HEAPF32.fill(0, out >> 2, (out >> 2) + 480);
    return 0;
  };
  const input = noise(12000, .1);
  const output = run(p, input, 1).output;
  assert.ok(error(output, Float32Array.from(input, v => v * .1), 1440) < 1e-7);
});

test('rnnoise: bundled WASM wet delay matches the dry delay', () => {
  const input = noise(24000, .12);
  const output = run(load(root, 'rnnoise'), input, 1).output;
  let bestDelay = 0, bestCorrelation = -Infinity;
  for (let delay = 400; delay < 1800; delay++) {
    let correlation = 0;
    for (let i = 2000; i < 22000; i++) {
      const wet = (output[i] - .1 * input[i - 1440]) / .9;
      correlation += wet * input[i - delay];
    }
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestDelay = delay; }
  }
  assert.equal(bestDelay, 1440);
});
