# Chrome Web Store assets

Everything the store listing asks for, ready to upload.

| Field in the dashboard | File | Size |
|---|---|---|
| Store icon | `icon-128.png` (same as `icons/icon128.png`) | 128×128, 96×96 artwork + 16 px transparent padding |
| Screenshots (English) | `screenshots/en/screenshot-1…5.png` | 1280×800, PNG without alpha |
| Screenshots (Portuguese) | `screenshots/pt/screenshot-1…5.png` | 1280×800, PNG without alpha |
| Small promo tile (required) | `promo/small-440x280.png` | 440×280 |
| Marquee promo tile (optional) | `promo/marquee-1400x560-en.png` / `-pt.png` | 1400×560 |

Suggested screenshot order (the first one is the most visible):

1. **clean** – Remove the hiss. Keep the voice.
2. **scan** – See every sound that never stops.
3. **picked** – Pick exactly what to remove.
4. **learning** – Learns your stream's noise in 30 seconds.
5. **ai** – Two filters, one click.

The Portuguese set goes in the listing's *Portuguese (Brazil)* localization (available because the package declares `en` and `pt_BR` in `_locales/`).

## How they were made

The popup in every screenshot is the real extension (version 1.3.0) running in Chromium, fed with a
synthetic "livestream" (speech with hiss, 60 Hz mains hum with harmonics, a 1 kHz beep and a
15.7 kHz whine), captured at 2× and placed in a generic browser window. The meter values and the
Scan results are the ones the extension actually showed. The text is set in Inter, standing in for
Segoe UI (the font the popup uses on Windows).
