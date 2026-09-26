// Builds the audio graph: tab MediaStream -> AudioWorklet (RNNoise) -> speakers.

// RNNoise was trained at 48 kHz. By creating the AudioContext at that rate,
// Chrome itself resamples if the tab audio comes at a different rate.
const SAMPLE_RATE = 48000;

export async function createDenoiser(stream, { mix = 1 } = {}) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./rnnoise-processor.js', import.meta.url));

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCountMode: 'explicit',
    channelCount: 2,
    channelInterpretation: 'speakers',
  });

  source.connect(node).connect(ctx.destination);
  if (ctx.state !== 'running') await ctx.resume();

  const state = { mix, bypass: false };
  const denoiser = {
    stats: null,

    setParams({ mix: newMix, bypass } = {}) {
      if (typeof newMix === 'number') state.mix = Math.min(1, Math.max(0, newMix));
      if (typeof bypass === 'boolean') state.bypass = bypass;
      const target = state.bypass ? 0 : state.mix;
      // ~30 ms ramp so moving the slider doesn't click.
      node.parameters.get('mix').setTargetAtTime(target, ctx.currentTime, 0.03);
    },

    close() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      ctx.close();
    },
  };

  node.port.onmessage = (e) => {
    if (e.data?.type === 'stats') denoiser.stats = e.data;
    if (e.data?.type === 'error') console.error('[NoHiss]', e.data.message);
  };

  denoiser.setParams({ mix });
  return denoiser;
}
