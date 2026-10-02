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

1. **clean** – Remove the hiss. Keep the voice. (Simple view)
2. **scan** – Pro: see every sound that never stops.
3. **picked** – Pick exactly what to remove.
4. **learning** – Works right away. (Simple view, first 30 s)
5. **ai** – Simple or Pro, you choose.

The Portuguese set goes in the listing's *Portuguese (Brazil)* localization. Other languages fall back to the English screenshots.

## Localized listing

The package declares 53 locales in `_locales/`, so the store shows the translated **name and short
summary** automatically in the visitor's language. The long **description** is entered per language
in the dashboard: the texts are in `listing/`, one file per language.

| Dashboard language | File |
|---|---|
| English | `listing/en.txt` |
| Português (Brasil) | `listing/pt_BR.txt` |
| Español | `listing/es.txt` (also fine for *Español (Latinoamérica)*) |
| Français | `listing/fr.txt` |
| Deutsch | `listing/de.txt` |
| Italiano | `listing/it.txt` |
| Nederlands | `listing/nl.txt` |
| Polski | `listing/pl.txt` |
| Türkçe | `listing/tr.txt` |
| Русский | `listing/ru.txt` |
| Українська | `listing/uk.txt` |
| العربية | `listing/ar.txt` |
| हिन्दी | `listing/hi.txt` |
| Bahasa Indonesia | `listing/id.txt` |
| Tiếng Việt | `listing/vi.txt` |
| ไทย | `listing/th.txt` |
| 日本語 | `listing/ja.txt` |
| 한국어 | `listing/ko.txt` |
| 中文（简体） | `listing/zh_CN.txt` |
| 中文（繁體） | `listing/zh_TW.txt` |

Languages without a long description of their own show the English one, under the translated name and summary.

## How they were made

The popup in every screenshot is the real extension (version 1.5.0) running in Chromium, fed with a
synthetic "livestream" (speech with hiss, 60 Hz mains hum with harmonics, a 1 kHz beep and a
15.7 kHz whine), captured at 2× and placed in a generic browser window. The meter values and the
Scan results are the ones the extension actually showed. The text is set in Inter, standing in for
Segoe UI (the font the popup uses on Windows).
