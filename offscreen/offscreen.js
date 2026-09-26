// Offscreen document: receives the tab audio, runs it through the filter and plays
// the result. When a tab is captured, Chrome mutes its original sound,
// so the clean audio has to be played from here.

import { createDenoiser } from '../audio/pipeline.js';

let session = null; // { stream, denoiser }

const toBackground = (msg) =>
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

async function start({ streamId, mode, amount, profile, scan, selection }) {
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

  const denoiser = await createDenoiser(stream, { mode, amount, profile, scan, selection });
  // Persist the learned profile and scan for the next time the extension is turned on.
  denoiser.onProfileLearned = (prof, summary, newScan, newSelection) =>
    toBackground({
      type: 'save-learned',
      profile: { profile: prof, ...summary },
      scan: newScan,
      selection: newSelection,
    });
  session = { stream, denoiser };

  // If the tab closes or the capture drops, tell the service worker to clean up.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => toBackground({ type: 'capture-ended' }));
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
  const dn = session?.denoiser;

  switch (msg.type) {
    case 'start':
      start(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;

    case 'stop':
      stop();
      break;

    case 'set-params':
      dn?.setParams(msg);
      break;

    case 'learn':
      dn?.startLearning(msg.seconds || 30, { force: msg.force !== false });
      break;

    case 'cancel-learn':
      dn?.cancelLearning();
      break;

    case 'forget':
      dn?.forgetProfile();
      toBackground({ type: 'save-learned', profile: null, scan: null, selection: [] });
      break;

    case 'get-stats':
      sendResponse({
        ok: true,
        running: !!session,
        mode: dn?.mode ?? null,
        selection: dn?.selection ?? [],
        stats: dn?.stats ?? null,
        learn: dn?.learn ?? null,
      });
      return false;

    default:
      return false;
  }
  sendResponse({ ok: true });
  return false;
});
