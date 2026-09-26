# NoHiss 🎧

A Chrome extension that **removes hiss and background noise from any tab's audio, in real time** — livestreams, videos, recorded classes, podcasts.

The filter is **RNNoise**, a small noise-suppression neural network (by Xiph.Org/Mozilla) compiled to WebAssembly. Everything runs on your computer; no audio is ever sent to a server.

## Features

- Turn it on and off per tab with one click.
- Adjustable **strength** from 0 to 100% — it mixes the original sound with the cleaned one, which helps when the stream has music.
- **A/B comparison:** hold the button to hear the original, release to go back to the clean audio.
- Meter showing how much noise is being removed (dB) and a voice-activity indicator.
- ~30 ms of latency, so the voice stays in sync with the video.

## Install (developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the project folder.
5. Pin the icon, open the stream's tab, click the icon and then the button to clean the tab's audio.

Works on Chrome 116+ and Chromium-based browsers (Edge, Brave, Opera).

## How it works

```
Tab (stream)  ──tabCapture──▶  Offscreen document  ──▶  AudioWorklet (RNNoise/WASM)  ──▶  Speakers
                                     ▲
Popup ──messages──▶ Service worker ──┘
```

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3; `tabCapture`, `offscreen` and `storage` permissions; CSP allowing WebAssembly. |
| `background.js` | Service worker. Gets the tab's *stream id* (`chrome.tabCapture.getMediaStreamId`), creates the offscreen document, handles on/off and the "ON" badge. |
| `offscreen/` | Hidden document that opens the tab audio with `getUserMedia`. It exists because the MV3 service worker has no access to the Web Audio API. |
| `audio/pipeline.js` | Builds the Web Audio graph: `MediaStreamSource → AudioWorkletNode → destination`, at 48 kHz. |
| `audio/rnnoise-processor.js` | The core of the project — details below. |
| `popup/` | The UI. |

### Processor details (`rnnoise-processor.js`)

- Web Audio delivers **128-sample** blocks, while RNNoise works on **480-sample** frames (10 ms at 48 kHz). The processor buffers the input, processes frame by frame and outputs through a ring buffer with a fixed delay.
- RNNoise adds another **960 samples (20 ms)** of internal delay. The original signal is delayed by exactly the same amount before mixing; otherwise the strength control would cause a comb-filter effect (metallic sound).
- Stereo audio uses one RNNoise instance per channel.
- Samples are scaled to the 16-bit range (×32768), which is what RNNoise expects.

### Why does capturing "mute" the tab?

When an extension captures a tab's audio, Chrome mutes the original sound. That's why the processed audio is played by the offscreen document. When you turn it off, the capture ends and the original sound comes back.

## Tests

The processor was validated in a real Chromium `AudioWorklet` with synthesized speech + hiss (10 dB SNR):

- Hiss-only stretches: **−21 dB → −105 dB** (total silence).
- Speech: level preserved (gain ~0.96) and the signal-to-noise ratio goes from **8.7 dB to 13.8 dB**.
- "Original" mode (bypass): output identical to the input, bit for bit, just delayed.

## Limitations

- RNNoise was trained on **voice**. With music it may muffle instruments; lower the strength in that case.
- Internal pages (`chrome://`) and the Chrome Web Store can't be captured.
- One tab at a time.

## Ideas

- Keyboard shortcut to toggle (`commands` in the manifest).
- EQ or compressor after RNNoise to make the voice more "present".
- Turn on automatically for sites chosen by the user.
- Publish on the Chrome Web Store (one-time developer registration fee).

## Credits and licenses

- [RNNoise](https://github.com/xiph/rnnoise), Jean-Marc Valin / Xiph.Org, BSD-3-Clause license.
- [rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm), WebAssembly build by Jitsi, Apache-2.0 license (see `audio/vendor/RNNOISE-WASM-LICENSE.txt`).
