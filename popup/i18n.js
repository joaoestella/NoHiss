// UI strings live in popup/locales/<code>.json. The popup follows Chrome's own
// language by default; the language menu in the header overrides it, and that
// choice is saved in chrome.storage.local.

// [code, native name], in the order shown in the menu.
export const LANGUAGES = [
  ['en', 'English'],
  ['pt', 'Português'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
  ['tr', 'Türkçe'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['ar', 'العربية'],
  ['hi', 'हिन्दी'],
  ['id', 'Bahasa Indonesia'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh_CN', '简体中文'],
  ['zh_TW', '繁體中文'],
];
const CODES = new Set(LANGUAGES.map(([code]) => code));
const RTL = new Set(['ar']);
// BCP 47 tags for <html lang> and number formatting.
const BCP47 = { pt: 'pt-BR', zh_CN: 'zh-CN', zh_TW: 'zh-TW' };

let lang = 'en';
let strings = {};
let fallback = null;
const cache = new Map();

async function load(code) {
  if (!cache.has(code)) {
    cache.set(code, fetch(new URL(`./locales/${code}.json`, import.meta.url)).then((r) => r.json()));
  }
  return cache.get(code);
}

// Maps a browser language ("pt-BR", "zh-HK", "es-419"…) to a supported one.
export function detectLang(ui = 'en') {
  const tag = String(ui).replace('-', '_');
  if (CODES.has(tag)) return tag;
  const [base, region = ''] = tag.split('_');
  if (base === 'zh') return /^(TW|HK|MO|Hant)/i.test(region) ? 'zh_TW' : 'zh_CN';
  return CODES.has(base) ? base : 'en';
}

export async function setLang(next) {
  lang = CODES.has(next) ? next : 'en';
  fallback ??= await load('en');
  strings = lang === 'en' ? fallback : await load(lang);
  document.documentElement.lang = BCP47[lang] ?? lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
}

export function getLang() {
  return lang;
}

// Locale for Intl (decimal separators etc.).
export function getLocale() {
  return BCP47[lang] ?? lang;
}

// t('learn.level', { db: -21 }) -> "level -21 dB"
// Each inserted value is wrapped in a Unicode bidi isolate (FSI…PDI), so a
// number like "-21" keeps its order inside right-to-left text (Arabic).
export function t(key, vars = {}) {
  const str = strings[key] ?? fallback?.[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, name) => `\u2068${vars[name] ?? ''}\u2069`);
}

export function has(key) {
  return Boolean(fallback && key in fallback);
}

// Fills every element that has data-i18n (text) or data-i18n-* (attributes).
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
}
