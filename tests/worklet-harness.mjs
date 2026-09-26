import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
export function load(root, name) {
  let Processor;
  const context = vm.createContext({
    console, WebAssembly, performance, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, p) => { Processor = p; },
  });
  if (name === 'rnnoise') {
    const vendor = fs.readFileSync(path.join(root, 'audio/vendor/rnnoise-sync.js'), 'utf8')
      .replace('import.meta.url', "'file:///rnnoise-sync.js'")
      .replace('export default createRNNWasmModuleSync;', '');
    vm.runInContext(vendor, context);
  }
  const code = fs.readFileSync(path.join(root, `audio/${name}-processor.js`), 'utf8')
    .replace(/^import .*;$/m, '');
  vm.runInContext(code, context);
  return new Processor();
}
export function run(p, input, amount, bypass = false, right = null) {
  const output = new Float32Array(input.length);
  const outputR = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) {
    const a = input.slice(i, i + 128), b = right?.slice(i, i + 128);
    const out = [new Float32Array(a.length), new Float32Array(a.length)];
    p.process([b ? [a, b] : [a]], [out], {
      mix: new Float32Array([bypass ? 0 : amount]),
      amount: new Float32Array([amount]), bypass: new Float32Array([+bypass]),
    });
    output.set(out[0], i); outputR.set(out[1], i);
  }
  return { output, outputR };
}
export function noise(n, amplitude = .025) {
  let seed = 42;
  return Float32Array.from({length:n}, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296 * 2 - 1) * amplitude * Math.sqrt(3);
  });
}
export function rms(x, start = 0, end = x.length) {
  let sum = 0; for (let i = start; i < end; i++) sum += x[i] ** 2;
  return Math.sqrt(sum / (end - start));
}

