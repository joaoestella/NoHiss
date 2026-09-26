// "Scan" tab: lists every constant sound found by the last scan, lets the
// user pick which ones to remove and draws them on a spectrum.

import { analyze } from '../audio/components.js';
import { t, getLang } from './i18n.js';

const COLORS = ['#22c55e', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15'];
const F_MIN = 50;
const F_MAX = 20000;
const xOf = (f, W) => (Math.log(Math.max(f, F_MIN) / F_MIN) / Math.log(F_MAX / F_MIN)) * W;

export function formatHz(f) {
  const dec = getLang() === 'pt' ? ',' : '.';
  if (f < 1000) return `${Math.round(f)} Hz`;
  const k = f / 1000;
  return `${(k >= 10 ? k.toFixed(1) : k.toFixed(2)).replace('.', dec)} kHz`;
}

export function componentLabel(c) {
  if (c.kind === 'band') {
    const name = t(`comp.${c.band}`);
    const sub = c.band === 'rumble'
      ? t('comp.below', { f: formatHz(c.hi) })
      : t('comp.range', { lo: formatHz(c.lo), hi: formatHz(Math.min(c.hi, F_MAX)) });
    return { name, sub };
  }
  const f = formatHz(c.freq);
  const sub = c.harmonics === 0 ? f
    : c.harmonics === 1 ? t('comp.harmonic1', { f })
    : t('comp.harmonics', { f, n: c.harmonics });
  return { name: t(`comp.${c.kind}`), sub };
}

export function createScanPanel(els, { onToggle }) {
  let components = [];
  let colorOf = new Map();
  let lastKey = '';
  let lastScan;

  function setScan(scan) {
    if (scan === lastScan) return;
    lastScan = scan;
    components = analyze(scan);
    colorOf = new Map(components.map((c, i) => [c.id, COLORS[i % COLORS.length]]));
    lastKey = '';
  }

  function renderList(selected) {
    els.list.replaceChildren();
    for (const c of components) {
      const { name, sub } = componentLabel(c);
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'comp';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(c.id);
      box.dataset.id = c.id;
      box.addEventListener('change', () => onToggle(c.id, box.checked));

      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = colorOf.get(c.id);

      const text = document.createElement('span');
      text.className = 'comp-text';
      const n = document.createElement('span');
      n.className = 'comp-name';
      n.textContent = name;
      const s = document.createElement('span');
      s.className = 'comp-sub';
      s.textContent = sub;
      text.append(n, s);

      const level = document.createElement('span');
      level.className = 'comp-level';
      level.textContent = `${Math.round(c.levelDb)} dB`;

      label.append(box, swatch, text, level);
      li.append(label);
      els.list.append(li);
    }
    els.empty.hidden = components.length > 0;
  }

  // Spectrum of what's always there (the scan's floor), with the picked
  // broadband ranges shaded and the tones drawn as vertical lines.
  function drawChart(scan, selected) {
    const c = els.chart;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    g.clearRect(0, 0, W, H);

    g.font = '18px system-ui, sans-serif';
    g.fillStyle = '#6b7280';
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 2;
    for (const [hz, label] of [[100, '100'], [1000, '1k'], [10000, '10k Hz']]) {
      const x = xOf(hz, W);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      g.fillText(label, x + 5, H - 8);
    }
    if (!scan?.floor) return;

    const { fftN, sampleRate: fs, floor } = scan;
    const hz = fs / fftN;
    const db = (p) => 10 * Math.log10(p / (fftN * 0.5) + 1e-20);
    const pts = [];
    for (let k = 1; k < floor.length; k++) {
      const f = k * hz;
      if (f < F_MIN || f > F_MAX) continue;
      pts.push([xOf(f, W), db(floor[k]), f]);
    }
    // Tones are drawn from the high-resolution levels, so include them in the scale.
    const tops = components.filter((x) => x.kind !== 'band').map((x) => x.levelDb);
    const max = Math.max(...pts.map((p) => p[1]), ...tops);
    const min = max - 70;
    const yOf = (v) => 8 + (1 - (Math.max(v, min) - min) / (max - min)) * (H - 36);

    const bandAt = (f) => components.find((x) => x.kind === 'band' && f >= x.lo && f < x.hi);
    // Shaded ranges (one path per band so each gets its own color).
    for (const band of components.filter((x) => x.kind === 'band')) {
      const seg = pts.filter((p) => bandAt(p[2]) === band);
      if (seg.length < 2) continue;
      g.beginPath();
      g.moveTo(seg[0][0], H);
      for (const [x, v] of seg) g.lineTo(x, yOf(v));
      g.lineTo(seg[seg.length - 1][0], H);
      g.closePath();
      g.globalAlpha = selected.has(band.id) ? 0.45 : 0.12;
      g.fillStyle = colorOf.get(band.id);
      g.fill();
      g.globalAlpha = 1;
    }

    g.beginPath();
    pts.forEach(([x, v], i) => (i ? g.lineTo(x, yOf(v)) : g.moveTo(x, yOf(v))));
    g.strokeStyle = 'rgba(232,234,240,0.7)';
    g.lineWidth = 2;
    g.stroke();

    for (const tone of components.filter((x) => x.kind !== 'band')) {
      const on = selected.has(tone.id);
      g.strokeStyle = colorOf.get(tone.id);
      g.lineWidth = on ? 4 : 2;
      g.setLineDash(on ? [] : [6, 6]);
      for (const f of tone.freqs) {
        if (f < F_MIN || f > F_MAX) continue;
        const x = xOf(f, W);
        g.beginPath(); g.moveTo(x, H); g.lineTo(x, yOf(tone.levelDb)); g.stroke();
      }
      g.setLineDash([]);
    }
  }

  return {
    setScan,
    get components() {
      return components;
    },
    // Rebuilds the list only when the sounds or the language change; a new
    // selection just updates the checkboxes (so the clicked one keeps focus).
    render(scan, selected) {
      const listKey = `${getLang()}|${components.map((c) => c.id).join(',')}`;
      const key = `${listKey}|${[...selected].sort().join(',')}`;
      if (key === lastKey) return;
      if (lastKey.startsWith(`${listKey}|`) || lastKey === listKey) {
        for (const box of els.list.querySelectorAll('input')) box.checked = selected.has(box.dataset.id);
      } else {
        renderList(selected);
      }
      lastKey = key;
      drawChart(scan, selected);
    },
  };
}
