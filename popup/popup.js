const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  toggle: $('toggle'),
  error: $('error'),
  controls: $('controls'),
  mix: $('mix'),
  mixValue: $('mixValue'),
  reduction: $('reduction'),
  reductionBar: $('reductionBar'),
  voiceDot: $('voiceDot'),
  vadValue: $('vadValue'),
  compare: $('compare'),
};

let tabId = null;
let running = false;
let statsTimer = null;

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
  } else if (!running && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
    renderStats(null);
  }
}

function renderStats(stats) {
  if (!stats) {
    els.reduction.textContent = '— dB';
    els.reductionBar.style.width = '0%';
    els.voiceDot.classList.remove('on');
    els.vadValue.textContent = '—';
    return;
  }
  const db = stats.reductionDb;
  // On hiss-only stretches the reduction goes past 60 dB; above 40 it's silence anyway.
  els.reduction.textContent = db >= 40 ? '40+ dB' : `${db.toFixed(1)} dB`;
  els.reductionBar.style.width = `${Math.min(100, (db / 30) * 100)}%`;
  els.voiceDot.classList.toggle('on', stats.vad > 0.5);
  els.vadValue.textContent = `${Math.round(stats.vad * 100)}%`;
}

async function pollStats() {
  const res = await toOffscreen({ type: 'get-stats' });
  if (res?.ok && res.running) renderStats(res.stats);
}

function renderMix(value) {
  els.mix.value = String(Math.round(value * 100));
  els.mixValue.textContent = `${Math.round(value * 100)}%`;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const { mix = 1 } = await chrome.storage.local.get('mix');
  renderMix(mix);

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

els.mix.addEventListener('input', () => {
  const mix = Number(els.mix.value) / 100;
  els.mixValue.textContent = `${els.mix.value}%`;
  toOffscreen({ type: 'set-params', mix });
  chrome.storage.local.set({ mix });
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
