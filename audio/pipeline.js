// Builds the audio graph: tab MediaStream -> filter -> speakers.
//
// Three modes are available:
//  - 'spectral' (default): spectral subtraction, built for constant hiss.
//    It can "learn" the hiss by listening to 30 s of audio.
//  - 'rnnoise': voice-focused neural network. Good for varying noise
//    (keyboard, fan), but it can wipe out music and very hissy voices.
//  - 'custom': removes only the constant sounds picked from a scan
//    (the same 30 s pass that learns the hiss). Runs on the spectral node.

import { analyze, compose } from './components.js';

// RNNoise was trained at 48 kHz, and the FFT was also sized for that
// rate. If the tab uses a different rate, Chrome resamples it.
const SAMPLE_RATE = 48000;

export async function createDenoiser(
  stream,
  { mode = 'spectral', amount = 0.6, profile = null, scan = null, selection = [] } = {},
) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await Promise.all([
    ctx.audioWorklet.addModule(new URL('./spectral-processor.js', import.meta.url)),
    ctx.audioWorklet.addModule(new URL('./rnnoise-processor.js', import.meta.url)),
  ]);

  const source = ctx.createMediaStreamSource(stream);
  const nodeOptions = {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCountMode: 'explicit',
    channelCount: 2,
    channelInterpretation: 'speakers',
  };

  const nodes = { spectral: new AudioWorkletNode(ctx, 'spectral-processor', nodeOptions), rnnoise: null };

  // RNNoise (2 MB of WebAssembly) is only loaded if that mode is used.
  function getNode(which) {
    if (which === 'rnnoise' && !nodes.rnnoise) {
      nodes.rnnoise = new AudioWorkletNode(ctx, 'rnnoise-processor', nodeOptions);
      nodes.rnnoise.port.onmessage = onNodeMessage;
    }
    return nodes[which];
  }

  const state = { mode: null, amount, bypass: false, selection: [...selection] };
  const nodeFor = (m) => (m === 'rnnoise' ? 'rnnoise' : 'spectral');

  // Wiring: the active filter is fed and heard. The spectral node is also fed
  // while learning/scanning in AI mode (so the scan still hears the tab), but
  // then its output isn't connected, so nothing plays twice.
  const wired = { spectralIn: false, spectralOut: false, rnnoiseIn: false, rnnoiseOut: false };
  function wire(name, part, on) {
    const key = name + part;
    if (wired[key] === on) return;
    const node = getNode(name);
    if (part === 'In') on ? source.connect(node) : source.disconnect(node);
    else on ? node.connect(ctx.destination) : node.disconnect(ctx.destination);
    wired[key] = on;
  }
  function route() {
    const active = nodeFor(state.mode);
    const scanning = denoiser.learn.status === 'learning';
    wire('spectral', 'In', active === 'spectral' || scanning);
    wire('spectral', 'Out', active === 'spectral');
    if (active === 'rnnoise' || nodes.rnnoise) {
      wire('rnnoise', 'In', active === 'rnnoise');
      wire('rnnoise', 'Out', active === 'rnnoise');
    }
  }

  // Custom mode: turns the picked sounds into a profile + notch list.
  function applyCustom() {
    if (state.mode !== 'custom' || !denoiser.scan) {
      nodes.spectral.port.postMessage({ type: 'set-custom', active: false });
      return;
    }
    const { profile: prof, notches } = compose(denoiser.scan, state.selection);
    nodes.spectral.port.postMessage({ type: 'set-custom', active: true, profile: prof, notches });
  }

  const denoiser = {
    stats: null,
    learn: { status: profile ? 'learned' : 'idle', progress: 0, levelDb: null, curve: null, saved: !!profile },
    scan,

    get mode() {
      return state.mode;
    },

    get selection() {
      return state.selection;
    },

    setParams({ mode: newMode, amount: newAmount, mix, bypass, selection: newSelection } = {}) {
      if (typeof mix === 'number' && typeof newAmount !== 'number') newAmount = mix;
      if (typeof newAmount === 'number') state.amount = Math.min(1, Math.max(0, newAmount));
      if (typeof bypass === 'boolean') state.bypass = bypass;

      let customChanged = false;
      if (Array.isArray(newSelection)) {
        state.selection = [...newSelection];
        customChanged = true;
      }
      if (['spectral', 'rnnoise', 'custom'].includes(newMode) && newMode !== state.mode) {
        if (nodeFor(newMode) !== nodeFor(state.mode)) denoiser.stats = null;
        state.mode = newMode;
        route();
        customChanged = true;
      }
      if (customChanged) applyCustom();

      const t = ctx.currentTime;
      const sp = nodes.spectral.parameters;
      sp.get('amount').setTargetAtTime(state.amount, t, 0.03);
      sp.get('bypass').setValueAtTime(state.bypass ? 1 : 0, t);
      if (nodes.rnnoise) {
        // ~30 ms ramp so moving the slider doesn't click.
        nodes.rnnoise.parameters.get('mix').setTargetAtTime(state.bypass ? 0 : state.amount, t, 0.03);
      }
    },

    // force=false keeps a pass that is already running (e.g. the automatic one).
    startLearning(seconds = 30, { force = true } = {}) {
      if (!force && denoiser.learn.status === 'learning') return;
      denoiser.learn = { ...denoiser.learn, status: 'learning', progress: 0, seconds, error: null };
      nodes.spectral.port.postMessage({ type: 'learn', seconds });
      route();
    },

    cancelLearning() {
      nodes.spectral.port.postMessage({ type: 'cancel-learn' });
      denoiser.learn = { ...denoiser.learn, status: denoiser.learn.levelDb !== null || denoiser.learn.saved ? 'learned' : 'idle' };
      route();
    },

    forgetProfile() {
      nodes.spectral.port.postMessage({ type: 'forget' });
      denoiser.learn = { status: 'idle', progress: 0, levelDb: null, curve: null, saved: false };
      denoiser.scan = null;
      applyCustom();
    },

    onProfileLearned: null, // callback(profile, summary, scan) used to persist them

    close() {
      for (const n of Object.values(nodes)) {
        if (!n) continue;
        n.port.onmessage = null;
        n.disconnect();
      }
      source.disconnect();
      ctx.close();
    },
  };

  function onNodeMessage(e) {
    const d = e.data;
    if (!d) return;
    if (d.type === 'stats') {
      // Only the stats from the filter that is currently playing count.
      if (e.target === nodes[state.mode]?.port) denoiser.stats = d;
    } else if (d.type === 'learn-progress') {
      if (denoiser.learn.status === 'learning') denoiser.learn = { ...denoiser.learn, progress: d.progress };
    } else if (d.type === 'learn-failed') {
      denoiser.learn = {
        ...denoiser.learn,
        status: denoiser.learn.levelDb !== null || denoiser.learn.saved ? 'learned' : 'idle',
        error: 'silence', // translated by the popup
      };
      route();
    } else if (d.type === 'learned') {
      if (!d.profile) return;
      denoiser.learn = { status: 'learned', progress: 1, levelDb: d.levelDb, curve: d.curve, saved: false };
      denoiser.scan = d.scan ?? null;
      // A new scan may not contain every previously picked sound.
      const ids = new Set(analyze(denoiser.scan).map((c) => c.id));
      state.selection = state.selection.filter((id) => ids.has(id));
      route();
      applyCustom();
      denoiser.onProfileLearned?.(d.profile, { levelDb: d.levelDb, curve: d.curve }, denoiser.scan, state.selection);
    } else if (d.type === 'error') {
      console.error('[NoHiss]', d.message);
    }
  }
  nodes.spectral.port.onmessage = onNodeMessage;

  if (profile?.profile) {
    nodes.spectral.port.postMessage({ type: 'set-profile', profile: profile.profile });
    denoiser.learn.levelDb = profile.levelDb ?? null;
    denoiser.learn.curve = profile.curve ?? null;
  }

  denoiser.setParams({ mode, amount });
  if (ctx.state !== 'running') await ctx.resume();
  return denoiser;
}
