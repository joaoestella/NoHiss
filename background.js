// Service worker: coordinates tab capture and the offscreen document.
// The service worker can't process audio, so it only grabs the tab's
// "stream id" and hands it to the offscreen document, which does the rest.

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const DEFAULTS = { mode: 'spectral', amount: 0.8, profile: null };

async function getActiveTabId() {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId ?? null;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Process the captured tab audio to remove noise.',
  });
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
  } catch {
    // The tab may already be closed.
  }
}

async function stopCapture() {
  const tabId = await getActiveTabId();
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    } catch {
      // The document was already shutting down.
    }
    await chrome.offscreen.closeDocument();
  }
  await chrome.storage.session.remove('activeTabId');
  if (tabId !== null) await setBadge(tabId, false);
}

async function startCapture(tabId) {
  // One tab at a time: if another one is active, stop it first.
  const current = await getActiveTabId();
  if (current !== null) await stopCapture();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();

  const { mode, amount, profile } = await chrome.storage.local.get(DEFAULTS);
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    mode,
    amount,
    profile,
  });
  if (!result?.ok) {
    await chrome.offscreen.closeDocument().catch(() => {});
    throw new Error(result?.error || 'start-failed');
  }

  await chrome.storage.session.set({ activeTabId: tabId });
  await setBadge(tabId, true);
}

// Known failures become codes that the popup translates; anything else is
// passed through as the raw message.
function errorCode(err) {
  const msg = String(err?.message || err);
  if (/Chrome pages cannot be captured|chrome:\/\//i.test(msg)) return 'chrome-page';
  if (/active stream/i.test(msg)) return 'already-captured';
  if (/not been invoked|activeTab|permission/i.test(msg)) return 'not-invoked';
  return msg;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;

  (async () => {
    switch (msg.type) {
      case 'get-state':
        return { activeTabId: await getActiveTabId() };
      case 'start':
        await startCapture(msg.tabId);
        return { ok: true };
      case 'stop':
        await stopCapture();
        return { ok: true };
      case 'save-profile':
        // Learned hiss profile (or null to forget it).
        await chrome.storage.local.set({ profile: msg.profile });
        return { ok: true };
      case 'capture-ended':
        // The tab was closed or the capture dropped for some other reason.
        await stopCapture();
        return { ok: true };
      default:
        return { ok: false, error: `Mensagem desconhecida: ${msg.type}` };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errorCode(err) }));

  return true; // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getActiveTabId())) await stopCapture();
});
