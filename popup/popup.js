import { t, setLang, getLang, applyStatic, has } from './i18n.js';
import { createScanPanel } from './scan-panel.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  lang: $('lang'),
  toggle: $('toggle'),
  error: $('error'),
  controls: $('controls'),
  tabs: [...document.querySelectorAll('.tabs button')],
  panelClean: $('panelClean'),
  panelScan: $('panelScan'),
  scanIdle: $('scanIdle'),
  scanRunning: $('scanRunning'),
  scanDone: $('scanDone'),
  scanBtn: $('scanBtn'),
  scanTime: $('scanTime'),
  scanBar: $('scanBar'),
  scanAgain: $('scanAgain'),
  scanError: $('scanError'),
  modeButtons: [...document.querySelectorAll('.segmented button')],
  modeHint: $('modeHint'),
  learnBox: $('learnBox'),
  learnIdle: $('learnIdle'),
  learnRunning: $('learnRunning'),
  learnDone: $('learnDone'),
  learnBtn: $('learnBtn'),
  learnError: $('learnError'),
  learnTime: $('learnTime'),
  learnBar: $('learnBar'),
  learnCancel: $('learnCancel'),
  learnLevel: $('learnLevel'),
  learnAgain: $('learnAgain'),
  forget: $('forget'),
  curve: $('curve'),
  amount: $('amount'),
  amountValue: $('amountValue'),
  reduction: $('reduction'),
  meterLabel: $('meterLabel'),
  reductionBar: $('reductionBar'),
  vadRow: $('vadRow'),
  voiceDot: $('voiceDot'),
  vadValue: $('vadValue'),
  compare: $('compare'),
};

const LEARN_SECONDS = 30;

let tabId = null;
let running = false;
let mode = 'spectral';
let currentTab = 'clean';
let scan = null;        // last scan of constant sounds (from storage)
let selection = [];     // ids of the sounds picked in the Scan tab

const scanPanel = createScanPanel(
  { list: $('scanList'), empty: $('scanEmpty'), chart: $('scanChart') },
  { onToggle: toggleComponent },
);
let statsTimer = null;
let lastCurveKey = '';

// Last rendered state, so everything can be redrawn when the language changes.
let activeElsewhere = false;
let lastLearn = { status: 'idle' };
let lastStats = null;
let lastError = '';
let bypassOn = false;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });
const toOffscreen = (msg) =>
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => null);

// Errors come from the service worker as codes ("chrome-page", ...) or, for
// unexpected failures, as raw messages that are shown as they are.
function translateError(codeOrText) {
  if (!codeOrText) return '';
  return has(`error.${codeOrText}`) ? t(`error.${codeOrText}`) : codeOrText;
}

function showError(codeOrText) {
  lastError = codeOrText || '';
  els.error.textContent = translateError(lastError);
  els.error.hidden = !lastError;
}

function render() {
  els.status.textContent = t(running ? 'status.on' : activeElsewhere ? 'status.elsewhere' : 'status.off');
  els.status.classList.toggle('on', running);
  els.toggle.textContent = t(running ? 'toggle.stop' : activeElsewhere ? 'toggle.switch' : 'toggle.start');
  els.toggle.classList.toggle('stop', running);
  els.controls.setAttribute('aria-disabled', String(!running));

  if (running && !statsTimer) {
    statsTimer = setInterval(pollStats, 250);
    pollStats();
  } else if (!running && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
    renderStats(null);
  }
}

function renderMode() {
  for (const b of els.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  els.modeHint.textContent = mode === 'custom'
    ? t('mode.hint.custom', { n: selection.length })
    : t(`mode.hint.${mode}`);
  els.learnBox.hidden = mode !== 'spectral';
  els.vadRow.hidden = mode !== 'rnnoise';
  els.meterLabel.textContent = t(`meter.${mode}`);
}

function renderTabs() {
  for (const b of els.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === currentTab));
  els.panelClean.hidden = currentTab !== 'clean';
  els.panelScan.hidden = currentTab !== 'scan';
}

// The scan is the same 30 s pass that learns the hiss, so its progress comes
// from the learning state.
function renderScan() {
  const learning = lastLearn?.status === 'learning';
  els.scanRunning.hidden = !learning;
  els.scanIdle.hidden = learning || !!scan;
  els.scanDone.hidden = learning || !scan;
  els.scanError.textContent = lastLearn?.error ? t(`learn.error.${lastLearn.error}`) : '';
  els.scanError.hidden = !lastLearn?.error;
  if (learning) {
    const secs = Math.min(LEARN_SECONDS, Math.round((lastLearn.progress || 0) * LEARN_SECONDS));
    els.scanTime.textContent = `${secs} / ${LEARN_SECONDS} s`;
    els.scanBar.style.width = `${Math.round((lastLearn.progress || 0) * 100)}%`;
  }
  if (scan && !learning) {
    scanPanel.setScan(scan);
    scanPanel.render(scan, new Set(mode === 'custom' ? selection : []));
  }
}

function toggleComponent(id, checked) {
  // Picking something switches to custom mode; coming from another mode starts
  // from an empty selection so old picks don't come back unexpectedly.
  const base = mode === 'custom' ? selection : [];
  selection = checked ? [...new Set([...base, id])] : base.filter((x) => x !== id);
  mode = 'custom';
  chrome.storage.local.set({ mode, selection });
  toOffscreen({ type: 'set-params', mode, selection });
  renderMode();
  renderScan();
  renderStats(lastStats);
}

function renderStats(stats) {
  lastStats = stats;
  if (!stats) {
    els.reduction.textContent = '— dB';
    els.reductionBar.style.width = '0%';
    els.voiceDot.classList.remove('on');
    els.vadValue.textContent = '—';
    return;
  }
  // Custom mode with only tones picked: notch filters remove them completely,
  // there's no broadband estimate to measure, so show how many are filtered.
  if (mode === 'custom') {
    const picked = scanPanel.components.filter((c) => selection.includes(c.id));
    if (!picked.some((c) => c.kind === 'band')) {
      els.reduction.textContent = t('meter.tones', { n: picked.length });
      els.reductionBar.style.width = picked.length ? '100%' : '0%';
      return;
    }
  }
  // In Hiss/custom mode, show how much of the estimated noise was removed; in
  // AI mode, the level difference between input and output.
  const raw = typeof stats.noiseReductionDb === 'number' ? stats.noiseReductionDb : stats.reductionDb;
  const db = Math.max(0, raw);
  // On hiss-only stretches the reduction goes past 35 dB; above 40 it's silence anyway.
  els.reduction.textContent = db >= 40 ? '40+ dB' : `${db.toFixed(1)} dB`;
  els.reductionBar.style.width = `${Math.min(100, (db / 30) * 100)}%`;
  if (typeof stats.vad === 'number') {
    els.voiceDot.classList.toggle('on', stats.vad > 0.5);
    els.vadValue.textContent = `${Math.round(stats.vad * 100)}%`;
  }
}

function renderLearn(learn) {
  lastLearn = learn;
  renderScan();
  const status = learn?.status ?? 'idle';
  els.learnIdle.hidden = status !== 'idle';
  els.learnRunning.hidden = status !== 'learning';
  els.learnDone.hidden = status !== 'learned';
  els.learnError.textContent = learn?.error ? t(`learn.error.${learn.error}`) : '';
  els.learnError.hidden = !learn?.error;

  if (status === 'learning') {
    const secs = Math.min(LEARN_SECONDS, Math.round((learn.progress || 0) * LEARN_SECONDS));
    els.learnTime.textContent = `${secs} / ${LEARN_SECONDS} s`;
    els.learnBar.style.width = `${Math.round((learn.progress || 0) * 100)}%`;
  }
  if (status === 'learned') {
    els.learnLevel.textContent =
      typeof learn.levelDb === 'number' ? t('learn.level', { db: learn.levelDb.toFixed(0) }) : t('learn.saved');
    drawCurve(learn.curve);
  }
}

// Draws the learned hiss spectrum (dB per frequency, log scale).
function drawCurve(curve) {
  const key = curve ? curve.join(',') : '';
  if (key === lastCurveKey) return;
  lastCurveKey = key;

  const c = els.curve;
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);

  // Frequency ticks: position = log(f/50) / log(20000/50).
  g.font = '18px system-ui, sans-serif';
  g.fillStyle = '#6b7280';
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 2;
  for (const [hz, label] of [[100, '100'], [1000, '1k'], [10000, '10k Hz']]) {
    const x = (Math.log(hz / 50) / Math.log(400)) * W;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillText(label, x + 5, H - 8);
  }
  if (!curve?.length) return;

  const max = Math.max(...curve);
  const min = Math.max(Math.min(...curve), max - 60);
  const span = Math.max(12, max - min);
  const pts = curve.map((v, i) => [
    (i + 0.5) / curve.length * W,
    8 + (1 - (Math.max(v, min) - min) / span) * (H - 36),
  ]);

  g.beginPath();
  g.moveTo(pts[0][0], H);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(pts[pts.length - 1][0], H);
  g.closePath();
  g.fillStyle = 'rgba(34, 197, 94, 0.18)';
  g.fill();

  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = '#22c55e';
  g.lineWidth = 3;
  g.stroke();
}

async function pollStats() {
  const res = await toOffscreen({ type: 'get-stats' });
  if (!res?.ok || !res.running) return;
  renderStats(res.stats);
  renderLearn(res.learn);
}

function renderAmount(value) {
  els.amount.value = String(Math.round(value * 100));
  els.amountValue.textContent = `${Math.round(value * 100)}%`;
}

function renderAll() {
  applyStatic();
  render();
  renderTabs();
  renderMode();
  renderLearn(lastLearn);
  renderStats(lastStats);
  showError(lastError);
  setBypassLabel();
}

async function init() {
  const { lang } = await chrome.storage.local.get({ lang: 'en' });
  setLang(lang);
  applyStatic();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const saved = await chrome.storage.local.get({
    amount: 0.6,
    mode: 'spectral',
    profile: null,
    scan: null,
    selection: [],
    tab: 'clean',
  });
  mode = saved.mode;
  scan = saved.scan;
  selection = saved.selection;
  currentTab = saved.tab;
  renderAmount(saved.amount);
  renderMode();
  renderLearn(saved.profile ? { status: 'learned', ...saved.profile } : { status: 'idle' });

  const { activeTabId } = await toBackground({ type: 'get-state' });
  running = activeTabId === tabId;
  activeElsewhere = activeTabId !== null && !running;
  renderAll();
}

els.lang.addEventListener('click', () => {
  const next = getLang() === 'en' ? 'pt' : 'en';
  setLang(next);
  chrome.storage.local.set({ lang: next });
  renderAll();
});

async function setRunning(on) {
  showError('');
  els.toggle.disabled = true;
  try {
    const res = await toBackground({ type: on ? 'start' : 'stop', tabId });
    if (!res?.ok) throw new Error(res?.error || 'generic');
    running = on;
    activeElsewhere = false;
    render();
    return true;
  } catch (err) {
    showError(err.message);
    return false;
  } finally {
    els.toggle.disabled = false;
  }
}

els.toggle.addEventListener('click', () => setRunning(!running));

for (const b of els.tabs) {
  b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    chrome.storage.local.set({ tab: currentTab });
    renderTabs();
    renderScan();
  });
}

// Scanning needs the tab audio, so it turns the extension on if it's off.
// force=false keeps the automatic pass that starts with it.
async function scanTab(force) {
  if (!running && !(await setRunning(true))) return;
  toOffscreen({ type: 'learn', seconds: LEARN_SECONDS, force });
  renderLearn({ ...lastLearn, status: 'learning', progress: 0, error: null });
}
els.scanBtn.addEventListener('click', () => scanTab(false));
els.scanAgain.addEventListener('click', () => scanTab(true));

// The service worker stores new scans; pick them up while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('scan' in changes) scan = changes.scan.newValue ?? null;
  if ('selection' in changes) selection = changes.selection.newValue ?? [];
  if ('scan' in changes || 'selection' in changes) {
    renderMode();
    renderScan();
  }
});

for (const b of els.modeButtons) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    renderMode();
    renderScan();
    chrome.storage.local.set({ mode });
    toOffscreen({ type: 'set-params', mode });
  });
}

els.amount.addEventListener('input', () => {
  const amount = Number(els.amount.value) / 100;
  els.amountValue.textContent = `${els.amount.value}%`;
  toOffscreen({ type: 'set-params', amount });
  chrome.storage.local.set({ amount });
});

function startLearning() {
  toOffscreen({ type: 'learn', seconds: LEARN_SECONDS });
  renderLearn({ status: 'learning', progress: 0 });
}
els.learnBtn.addEventListener('click', startLearning);
els.learnAgain.addEventListener('click', startLearning);
els.learnCancel.addEventListener('click', () => toOffscreen({ type: 'cancel-learn' }));
els.forget.addEventListener('click', () => {
  toOffscreen({ type: 'forget' });
  scan = null;
  renderLearn({ status: 'idle' });
});

// A/B comparison: while the button is held, play the original audio.
function setBypassLabel() {
  els.compare.classList.toggle('held', bypassOn);
  els.compare.textContent = t(bypassOn ? 'compare.held' : 'compare.hold');
}
function setBypass(on) {
  bypassOn = on;
  setBypassLabel();
  toOffscreen({ type: 'set-params', bypass: on });
}
els.compare.addEventListener('pointerdown', (e) => {
  els.compare.setPointerCapture(e.pointerId);
  setBypass(true);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  els.compare.addEventListener(ev, () => setBypass(false));
}
els.compare.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    setBypass(true);
  }
});
els.compare.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Enter') setBypass(false);
});

init().catch((err) => showError(err.message));
