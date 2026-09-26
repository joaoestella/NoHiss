# NoHiss 🎧

A Chrome extension that **removes hiss and background noise from any tab's audio, in real time** — livestreams, videos, recorded classes, podcasts.

Its standout feature is the **"Learn the hiss"** button: the extension listens to 30 seconds of the stream itself and finds, band by band, the sound that is there all the time. From then on it removes only that pattern, so voice and music pass through. Everything runs on your computer.

## Features

- Turn it on and off per tab with one click.
- **Two filters:**
  - **Hiss** (default): spectral subtraction built for constant noise (bad mic, tape, radio). Keeps voice and music intact.
  - **Voice (AI):** [RNNoise](https://github.com/xiph/rnnoise), a neural network trained on voice. Removes varying noise, but may wipe out music.
- **Learn the hiss (30 s)** with a "hiss fingerprint" chart of the noise spectrum it found. The profile is saved for next time.
- **Strength:** how much hiss to remove (up to −35 dB).
- **A/B comparison:** hold the button to hear the original.
- Meter showing how much hiss is being removed.
- ~21 ms of latency, so the voice stays in sync with the video.

## Install (developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the project folder.
5. Pin the icon, open the stream's tab, click the icon and then the button to clean the tab's audio.
6. For the best result, click **Learn the hiss (30 s)** while the stream is playing.

Works on Chrome 116+ and Chromium-based browsers (Edge, Brave, Opera).

## How it works

```
Tab (stream) ──tabCapture──▶ Offscreen document ──▶ AudioWorklet ──▶ Speakers
                                   ▲                (Hiss or RNNoise)
Popup ──messages──▶ Service worker
```

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3; `tabCapture`, `offscreen` and `storage` permissions; CSP allowing WebAssembly. |
| `background.js` | Service worker. Gets the tab's *stream id*, creates the offscreen document, handles on/off and stores the learned profile. |
| `offscreen/` | Hidden document that opens the tab audio (the MV3 service worker has no Web Audio). |
| `audio/pipeline.js` | Web Audio graph at 48 kHz and switching between filters. |
| `audio/spectral-processor.js` | The hiss filter — details below. |
| `audio/rnnoise-processor.js` | The AI filter, RNNoise in WebAssembly. |
| `popup/` | The UI. |

### The hiss filter (`spectral-processor.js`)

1. **1024-point FFT with 75% overlap** (square-root Hann window). The audio becomes 513 frequency bands, recomputed every 5.3 ms.
2. **Noise-floor estimate for each band:**
   - *Automatic:* the lowest level over the last ~1.5 s (*minimum statistics*).
   - *Learned:* for 30 s it builds a histogram of each band's energy and takes the 10th percentile — voice and music come and go, hiss stays. The value is corrected for statistical bias (for Gaussian noise, a band's energy follows an exponential distribution).
   - *Lower envelope:* hiss is smooth across the spectrum; voice and music harmonics are narrow peaks. For each band the profile becomes the 30th percentile of its neighbors (±1/6 octave), so a long note doesn't end up in the profile as noise.
   - Digital silence (paused video) is ignored; otherwise the floor would "drop to zero" and the filter would stop working.
3. **Wiener gain with the decision-directed rule** (Ephraim–Malah): each band is lowered according to its signal-to-noise ratio, smoothed in time and frequency to avoid "musical noise" (the typical chirping of bad filters).
4. **Overlap-add reconstruction.**

### Why not just RNNoise?

The first version used only RNNoise. On a real stream it removed the voice along with the hiss, and in tests with sustained chords + hiss it kept only 12% of the music's level. RNNoise decides what is voice based on its training; when a sound doesn't look like what it knows, it gets cut. Hiss is constant and predictable, so a filter that *measures* the noise works better and leaves the rest alone.

## Test results

AudioWorklet in Chromium, synthesized speech + hiss (10 dB SNR), 45 s of audio:

| | Hiss in pauses | Voice (gain) | Speech SNR |
|---|---|---|---|
| Original | −21 dB | — | 10.8 dB |
| **Hiss filter (learned, 100%)** | **−52 dB** | **0.92** | **19.0 dB** |
| RNNoise | −50 dB | 0.96 | 14.3 dB |

- The learned hiss level matched the real one: −21.0 dB measured vs. −21.0 dB actual.
- With music instead of voice, the Hiss filter kept the music nearly intact (−1 to −2 dB) while RNNoise cut 4 to 6 dB.
- In "original" mode (bypass), the output is identical to the input.

## Language

The UI is in English by default. The button in the popup header switches to Brazilian Portuguese (and back); the choice is remembered.

## Limitations

- Noise that keeps changing (keyboard, traffic) isn't "hiss" — the Voice (AI) mode works better for that.
- Internal pages (`chrome://`) and the Chrome Web Store can't be captured.
- One tab at a time.

## Ideas

- Remove mains hum (50/60 Hz and harmonics) with notch filters.
- Keyboard shortcut to toggle.
- Per-site profiles.
- Publish on the Chrome Web Store.

## Credits and licenses

- [RNNoise](https://github.com/xiph/rnnoise), Jean-Marc Valin / Xiph.Org, BSD-3-Clause license.
- [rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm), WebAssembly build by Jitsi, Apache-2.0 license (see `audio/vendor/RNNOISE-WASM-LICENSE.txt`).
