const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  toggle: $('toggle'),
  error: $('error'),
  controls: $('controls'),
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
const MODE_HINTS = {
  spectral: 'Para chiado constante (microfone, fita, rádio). Preserva voz e música.',
  rnnoise: 'Rede neural treinada para voz. Tira ruídos variados, mas pode apagar música.',
};

let tabId = null;
let running = false;
let mode = 'spectral';
let statsTimer = null;
let lastCurveKey = '';

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });
const toOffscreen = (msg) =>
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => null);

function showError(text) {
  els.error.textContent = text || '';
  els.error.hidden = !text;
}

function render({ activeElsewhere = false } = {}) {
  els.status.textContent = running ? 'Ligado' : activeElsewhere ? 'Em outra aba' : 'Desligado';
  els.status.classList.toggle('on', running);
  els.toggle.textContent = running
    ? 'Parar e voltar ao áudio original'
    : activeElsewhere
      ? 'Limpar esta aba (para a outra)'
      : 'Limpar o áudio desta aba';
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
  els.modeHint.textContent = MODE_HINTS[mode];
  els.learnBox.hidden = mode !== 'spectral';
  els.vadRow.hidden = mode !== 'rnnoise';
  els.meterLabel.textContent = mode === 'spectral' ? 'Chiado removido' : 'Redução agora';
}

function renderStats(stats) {
  if (!stats) {
    els.reduction.textContent = '— dB';
    els.reductionBar.style.width = '0%';
    els.voiceDot.classList.remove('on');
    els.vadValue.textContent = '—';
    return;
  }
  // In Hiss mode, show how much of the estimated hiss was removed; in AI mode,
  // the level difference between input and output.
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
  const status = learn?.status ?? 'idle';
  els.learnIdle.hidden = status !== 'idle';
  els.learnRunning.hidden = status !== 'learning';
  els.learnDone.hidden = status !== 'learned';
  els.learnError.textContent = learn?.error || '';
  els.learnError.hidden = !learn?.error;

  if (status === 'learning') {
    const secs = Math.min(LEARN_SECONDS, Math.round((learn.progress || 0) * LEARN_SECONDS));
    els.learnTime.textContent = `${secs} / ${LEARN_SECONDS} s`;
    els.learnBar.style.width = `${Math.round((learn.progress || 0) * 100)}%`;
  }
  if (status === 'learned') {
    els.learnLevel.textContent =
      typeof learn.levelDb === 'number' ? `nível ${learn.levelDb.toFixed(0)} dB` : 'salvo';
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

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const saved = await chrome.storage.local.get({ amount: 0.8, mode: 'spectral', profile: null });
  mode = saved.mode;
  renderAmount(saved.amount);
  renderMode();
  renderLearn(saved.profile ? { status: 'learned', ...saved.profile } : { status: 'idle' });

  const { activeTabId } = await toBackground({ type: 'get-state' });
  running = activeTabId === tabId;
  render({ activeElsewhere: activeTabId !== null && !running });
}

els.toggle.addEventListener('click', async () => {
  showError('');
  els.toggle.disabled = true;
  try {
    const res = await toBackground({ type: running ? 'stop' : 'start', tabId });
    if (!res?.ok) throw new Error(res?.error || 'Algo deu errado.');
    running = !running;
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    els.toggle.disabled = false;
  }
});

for (const b of els.modeButtons) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    renderMode();
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
  renderLearn({ status: 'idle' });
});

// A/B comparison: while the button is held, play the original audio.
function setBypass(on) {
  els.compare.classList.toggle('held', on);
  els.compare.textContent = on ? 'Ouvindo o original…' : 'Segure para ouvir o original';
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
