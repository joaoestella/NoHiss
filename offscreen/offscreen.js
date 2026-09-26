// Offscreen document: receives the tab audio, runs it through RNNoise and plays
// the result. When a tab is captured, Chrome mutes its original sound,
// so the clean audio has to be played from here.

import { createDenoiser } from '../audio/pipeline.js';

let session = null; // { stream, denoiser }

async function start(streamId, mix) {
  if (session) stop();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const denoiser = await createDenoiser(stream, { mix });
  session = { stream, denoiser };

  // If the tab closes or the capture drops, tell the service worker to clean up.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      chrome.runtime.sendMessage({ target: 'background', type: 'capture-ended' }).catch(() => {});
    });
  }
}

function stop() {
  if (!session) return;
  session.stream.getTracks().forEach((t) => t.stop());
  session.denoiser.close();
  session = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'start':
      start(msg.streamId, msg.mix)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;

    case 'stop':
      stop();
      sendResponse({ ok: true });
      return false;

    case 'set-params':
      session?.denoiser.setParams(msg);
      sendResponse({ ok: true });
      return false;

    case 'get-stats':
      sendResponse({ ok: true, running: !!session, stats: session?.denoiser.stats ?? null });
      return false;

    default:
      return false;
  }
});
