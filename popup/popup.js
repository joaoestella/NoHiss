import { t, setLang, getLang, applyStatic, has, detectLang, LANGUAGES } from './i18n.js';
import { createScanPanel } from './scan-panel.js';

const $ = (id) => document.getElementById(id);
const els = {
  hero: $('hero'),
  heroTitle: $('heroTitle'),
  heroSub: $('heroSub'),
  chips: $('chips'),
  ringFill: $('ringFill'),
  toggleWord: $('toggleWord'),
  viewButtons: [...document.querySelectorAll('#view button')],
  simple: $('simple'),
  presets: [...document.querySelectorAll('.presets button')],
  compareText: $('compareText'),
  lang: $('lang'),
  langCode: $('langCode'),
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
const RING = 295.3; // circumference of the progress ring (r = 47)

// "Simple" always runs the automatic hiss filter with three strength presets;
// "Pro" shows the filters, the scan and the exact strength.
const PRESETS = [0.35, 0.6, 0.85];

let tabId = null;
let running = false;
let mode = 'spectral';   // the filter picked in Pro
let view = 'simple';
let amount = 0.6;
let shownDb = null;      // smoothed reduction for the big readout
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

// The filter that actually runs: Simple always uses the automatic hiss filter.
const activeMode = () => (view === 'simple' ? 'spectral' : mode);

function render() {
  const state = running ? 'on' : activeElsewhere ? 'elsewhere' : 'off';
  els.hero.dataset.state = state;
  els.toggle.setAttribute('aria-pressed', String(running));
  const word = t(running ? 'power.off' : activeElsewhere ? 'power.switch' : 'power.on');
  els.toggleWord.textContent = word;
  els.toggle.setAttribute('aria-label', word);
  els.chips.hidden = state !== 'off';
  els.controls.setAttribute('aria-disabled', String(!running));
  els.compare.hidden = !running;
  els.simple.hidden = view !== 'simple' || !running;
  els.controls.hidden = view !== 'pro';
  renderHero();

  if (running && !statsTimer) {
    statsTimer = setInterval(pollStats, 250);
    pollStats();
  } else if (!running && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
    renderStats(null);
  }
}

// Title + one short line under it. While the first 30 s pass runs, the filter
// is already working; the ring around the button shows it getting better.
function renderHero() {
  const learning = running && lastLearn?.status === 'learning';
  const progress = learning ? lastLearn.progress || 0 : 0;
  els.ringFill.style.strokeDashoffset = String(RING * (1 - progress));

  if (!running) {
    els.heroTitle.textContent = t(activeElsewhere ? 'hero.elsewhere' : 'hero.title');
    els.heroSub.textContent = activeElsewhere ? t('hero.elsewhereSub') : view === 'pro' ? t('hero.offSub') : '';
    return;
  }
  els.heroTitle.textContent = t('hero.on');
  let sub;
  if (learning) {
    sub = t('hero.learning', { s: Math.max(1, Math.ceil((1 - progress) * LEARN_SECONDS)) });
  } else if (lastLearn?.error) {
    sub = t(`learn.error.${lastLearn.error}`);
  } else if (view === 'pro') {
    sub = t('hero.tapOff');
  } else if (shownDb !== null && shownDb >= 1) {
    sub = t('hero.removed', { db: shownDb >= 40 ? '40+' : Math.round(shownDb) });
  } else {
    sub = t('hero.working');
  }
  els.heroSub.textContent = sub;
}

function renderView() {
  document.body.classList.toggle('pro-view', view === 'pro');
  document.body.classList.toggle('simple-view', view === 'simple');
  for (const b of els.viewButtons) b.setAttribute('aria-checked', String(b.dataset.view === view));
}

function renderPresets() {
  // Highlight the preset closest to the current strength (it may come from Pro).
  const near = PRESETS.reduce((a, b) => (Math.abs(b - amount) < Math.abs(a - amount) ? b : a));
  for (const b of els.presets) b.setAttribute('aria-checked', String(Number(b.dataset.amount) === near));
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
    shownDb = null;
    els.reduction.textContent = '— dB';
    els.reductionBar.style.width = '0%';
    els.voiceDot.classList.remove('on');
    els.vadValue.textContent = '—';
    return;
  }
  // Custom mode with only tones picked: notch filters remove them completely,
  // there's no broadband estimate to measure, so show how many are filtered.
  if (activeMode() === 'custom') {
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
  shownDb = shownDb === null ? db : shownDb * 0.8 + db * 0.2;
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
  renderHero();
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
  amount = value;
  renderPresets();
  els.amount.value = String(Math.round(value * 100));
  els.amountValue.textContent = `${Math.round(value * 100)}%`;
}

function renderAll() {
  applyStatic();
  renderView();
  render();
  renderTabs();
  renderMode();
  renderLearn(lastLearn);
  renderStats(lastStats);
  showError(lastError);
  setBypassLabel();
}

// Short label shown in the header; the menu itself lists the native names.
function renderLangControl() {
  const code = getLang();
  els.langCode.textContent = { zh_CN: '简', zh_TW: '繁' }[code] ?? code.toUpperCase();
  els.lang.value = code;
}

async function init() {
  for (const [code, name] of LANGUAGES) els.lang.add(new Option(name, code));
  // A language picked in the menu wins; otherwise follow Chrome's language.
  const { lang } = await chrome.storage.local.get('lang');
  await setLang(lang ?? detectLang(chrome.i18n.getUILanguage()));
  renderLangControl();
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
    view: null,
  });
  mode = saved.mode;
  // People who already used the advanced filters keep seeing them.
  view = saved.view ?? (saved.mode !== 'spectral' || saved.selection.length ? 'pro' : 'simple');
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

els.lang.addEventListener('change', async () => {
  await setLang(els.lang.value);
  chrome.storage.local.set({ lang: getLang() });
  renderLangControl();
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
    toOffscreen({ type: 'set-params', mode: activeMode() });
  });
}

function setAmount(value) {
  renderAmount(value);
  toOffscreen({ type: 'set-params', amount: value });
  chrome.storage.local.set({ amount: value });
}
els.amount.addEventListener('input', () => setAmount(Number(els.amount.value) / 100));
for (const b of els.presets) b.addEventListener('click', () => setAmount(Number(b.dataset.amount)));

for (const b of els.viewButtons) {
  b.addEventListener('click', () => {
    if (view === b.dataset.view) return;
    view = b.dataset.view;
    chrome.storage.local.set({ view });
    toOffscreen({ type: 'set-params', mode: activeMode() });
    renderView();
    render();
    renderMode();
    renderScan();
    renderStats(lastStats);
  });
}

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
  els.compareText.textContent = t(bypassOn ? 'compare.held' : 'compare.hold');
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
