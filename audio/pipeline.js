// Builds the audio graph: tab MediaStream -> filter -> speakers.
//
// Two filters are available:
//  - 'spectral' (default): spectral subtraction, built for constant hiss.
//    It can "learn" the hiss by listening to 30 s of audio.
//  - 'rnnoise': voice-focused neural network. Good for varying noise
//    (keyboard, fan), but it can wipe out music and very hissy voices.

// RNNoise was trained at 48 kHz, and the FFT was also sized for that
// rate. If the tab uses a different rate, Chrome resamples it.
const SAMPLE_RATE = 48000;

export async function createDenoiser(stream, { mode = 'spectral', amount = 0.8, profile = null } = {}) {
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
  nodes.spectral.connect(ctx.destination);

  // RNNoise (2 MB of WebAssembly) is only loaded if that mode is used.
  function getNode(which) {
    if (which === 'rnnoise' && !nodes.rnnoise) {
      nodes.rnnoise = new AudioWorkletNode(ctx, 'rnnoise-processor', nodeOptions);
      nodes.rnnoise.port.onmessage = onNodeMessage;
      nodes.rnnoise.connect(ctx.destination);
    }
    return nodes[which];
  }

  const state = { mode: null, amount, bypass: false };

  const denoiser = {
    stats: null,
    learn: { status: profile ? 'learned' : 'idle', progress: 0, levelDb: null, curve: null, saved: !!profile },

    get mode() {
      return state.mode;
    },

    setParams({ mode: newMode, amount: newAmount, mix, bypass } = {}) {
      if (typeof mix === 'number' && typeof newAmount !== 'number') newAmount = mix;
      if (typeof newAmount === 'number') state.amount = Math.min(1, Math.max(0, newAmount));
      if (typeof bypass === 'boolean') state.bypass = bypass;

      if ((newMode === 'spectral' || newMode === 'rnnoise') && newMode !== state.mode) {
        const next = getNode(newMode);
        if (state.mode) source.disconnect(nodes[state.mode]);
        source.connect(next);
        state.mode = newMode;
        denoiser.stats = null;
      }

      const t = ctx.currentTime;
      const sp = nodes.spectral.parameters;
      sp.get('amount').setTargetAtTime(state.amount, t, 0.03);
      sp.get('bypass').setValueAtTime(state.bypass ? 1 : 0, t);
      if (nodes.rnnoise) {
        // ~30 ms ramp so moving the slider doesn't click.
        nodes.rnnoise.parameters.get('mix').setTargetAtTime(state.bypass ? 0 : state.amount, t, 0.03);
      }
    },

    startLearning(seconds = 30) {
      denoiser.learn = { ...denoiser.learn, status: 'learning', progress: 0, seconds, error: null };
      nodes.spectral.port.postMessage({ type: 'learn', seconds });
    },

    cancelLearning() {
      nodes.spectral.port.postMessage({ type: 'cancel-learn' });
      denoiser.learn = { ...denoiser.learn, status: denoiser.learn.levelDb !== null || denoiser.learn.saved ? 'learned' : 'idle' };
    },

    forgetProfile() {
      nodes.spectral.port.postMessage({ type: 'forget' });
      denoiser.learn = { status: 'idle', progress: 0, levelDb: null, curve: null, saved: false };
    },

    onProfileLearned: null, // callback(profile) used to persist it

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
    } else if (d.type === 'learned') {
      if (!d.profile) return;
      denoiser.learn = { status: 'learned', progress: 1, levelDb: d.levelDb, curve: d.curve, saved: false };
      denoiser.onProfileLearned?.(d.profile, { levelDb: d.levelDb, curve: d.curve });
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
