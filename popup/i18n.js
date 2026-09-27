// UI strings. English is the default; the header button switches to
// Brazilian Portuguese and the choice is saved in chrome.storage.local.

export const LANGS = ['en', 'pt'];

const STRINGS = {
  en: {
    'app.sub': 'Cleans up tab audio',
    'lang.switch': 'PT',
    'lang.switchTitle': 'Mudar para português',
    'status.on': 'On',
    'status.off': 'Off',
    'status.elsewhere': 'Other tab',
    'toggle.start': "Clean this tab's audio",
    'toggle.stop': 'Stop and restore the original audio',
    'toggle.switch': 'Clean this tab (stops the other one)',
    'mode.label': 'Filter',
    'mode.spectral': 'Hiss',
    'mode.rnnoise': 'Voice (AI)',
    'mode.hint.spectral': 'For constant hiss (mic, tape, radio). Gentler reduction to help preserve voice and music.',
    'mode.hint.rnnoise': 'Neural network trained on voice. Removes varying noise, but may wipe out music.',
    'mode.hint.custom': 'Removing only what you picked in the Scan tab ({n}).',
    'tab.clean': 'Clean',
    'tab.scan': 'Scan',
    'scan.button': 'Scan this tab (30 s)',
    'scan.hint': 'Finds every sound that stays on the whole time (hiss, hum, whine…). Then you pick what to remove.',
    'scan.listening': 'Looking for constant sounds…',
    'scan.runningHint': 'Keep the tab playing as usual.',
    'scan.pick': 'Check what you want removed; it applies right away.',
    'scan.empty': 'No constant sounds found.',
    'scan.again': 'Scan again',
    'scan.chart': 'Spectrum of the constant sounds',
    'comp.hiss': 'Hiss',
    'comp.low': 'Background noise',
    'comp.rumble': 'Rumble',
    'comp.hum': 'Mains hum',
    'comp.tone': 'Steady tone',
    'comp.whine': 'High-pitched whine',
    'comp.below': 'below {f}',
    'comp.range': '{lo} – {hi}',
    'comp.harmonic1': '{f} + 1 harmonic',
    'comp.harmonics': '{f} + {n} harmonics',
    'learn.button': 'Learn the hiss (30 s)',
    'learn.hint': "Keep the stream playing as usual; people can be talking. It looks for the sound that's there all the time.",
    'learn.listening': 'Listening…',
    'learn.cancel': 'Cancel',
    'learn.fingerprint': 'Hiss fingerprint',
    'learn.level': 'level {db} dB',
    'learn.saved': 'saved',
    'learn.again': 'Learn again',
    'learn.forget': 'Forget',
    'learn.curveLabel': 'Spectrum of the learned hiss',
    'learn.error.silence': 'Heard nothing in those 30 s. Press play on the stream and try again.',
    'amount.label': 'Strength',
    'amount.hint': 'Start at 60%. Lower it if speech sounds metallic. Some background hiss is normal.',
    'meter.spectral': 'Hiss removed',
    'meter.rnnoise': 'Reduction now',
    'meter.custom': 'Picked noise removed',
    'meter.tones': '{n} tones',
    'meter.voice': 'Voice detected',
    'compare.hold': 'Hold to hear the original',
    'compare.held': 'Playing the original…',
    'footer': 'Everything runs on your computer',
    'privacy.link': 'Privacy policy',
    'error.chrome-page': "Chrome's internal pages can't be captured.",
    'error.already-captured': 'This tab is already being captured by another extension or app.',
    'error.not-invoked': 'Open the popup on the tab you want to clean and try again.',
    'error.start-failed': "Couldn't start the audio processing.",
    'error.generic': 'Something went wrong.',
  },
  pt: {
    'app.sub': 'Limpa o áudio da aba',
    'lang.switch': 'EN',
    'lang.switchTitle': 'Switch to English',
    'status.on': 'Ligado',
    'status.off': 'Desligado',
    'status.elsewhere': 'Em outra aba',
    'toggle.start': 'Limpar o áudio desta aba',
    'toggle.stop': 'Parar e voltar ao áudio original',
    'toggle.switch': 'Limpar esta aba (para a outra)',
    'mode.label': 'Filtro',
    'mode.spectral': 'Chiado',
    'mode.rnnoise': 'Voz (IA)',
    'mode.hint.spectral': 'Para chiado constante (microfone, fita, rádio). Redução suave para preservar melhor voz e música.',
    'mode.hint.rnnoise': 'Rede neural treinada para voz. Tira ruídos variados, mas pode apagar música.',
    'mode.hint.custom': 'Tirando só o que você marcou na aba Escanear ({n}).',
    'tab.clean': 'Limpar',
    'tab.scan': 'Escanear',
    'scan.button': 'Escanear esta aba (30 s)',
    'scan.hint': 'Encontra todo som que fica ligado o tempo todo (chiado, zumbido, apito…). Depois você escolhe o que tirar.',
    'scan.listening': 'Procurando sons constantes…',
    'scan.runningHint': 'Deixe a aba tocando normalmente.',
    'scan.pick': 'Marque o que quer tirar; vale na hora.',
    'scan.empty': 'Nenhum som constante encontrado.',
    'scan.again': 'Escanear de novo',
    'scan.chart': 'Espectro dos sons constantes',
    'comp.hiss': 'Chiado',
    'comp.low': 'Ruído de fundo',
    'comp.rumble': 'Ronco grave',
    'comp.hum': 'Zumbido da rede elétrica',
    'comp.tone': 'Tom constante',
    'comp.whine': 'Apito agudo',
    'comp.below': 'abaixo de {f}',
    'comp.range': '{lo} – {hi}',
    'comp.harmonic1': '{f} + 1 harmônico',
    'comp.harmonics': '{f} + {n} harmônicos',
    'learn.button': 'Aprender o chiado (30 s)',
    'learn.hint': 'Deixe a live tocando normalmente, pode ter gente falando. Ele procura o som que continua lá o tempo todo.',
    'learn.listening': 'Ouvindo o áudio…',
    'learn.cancel': 'Cancelar',
    'learn.fingerprint': 'Retrato do chiado',
    'learn.level': 'nível {db} dB',
    'learn.saved': 'salvo',
    'learn.again': 'Aprender de novo',
    'learn.forget': 'Esquecer',
    'learn.curveLabel': 'Espectro do chiado aprendido',
    'learn.error.silence': 'Não ouvi nada nesses 30 s. Dê play na live e tente de novo.',
    'amount.label': 'Intensidade',
    'amount.hint': 'Comece em 60%. Diminua se a voz ficar metálica. Um pouco de chiado é normal.',
    'meter.spectral': 'Chiado removido',
    'meter.rnnoise': 'Redução agora',
    'meter.custom': 'Ruído marcado removido',
    'meter.tones': '{n} tons',
    'meter.voice': 'Voz detectada',
    'compare.hold': 'Segure para ouvir o original',
    'compare.held': 'Ouvindo o original…',
    'footer': 'Tudo processado no seu computador',
    'privacy.link': 'Política de privacidade',
    'error.chrome-page': 'Páginas internas do Chrome não podem ser capturadas.',
    'error.already-captured': 'Esta aba já está sendo capturada por outra extensão ou aplicativo.',
    'error.not-invoked': 'Abra o popup na aba que você quer limpar e tente de novo.',
    'error.start-failed': 'Falha ao iniciar o processamento de áudio.',
    'error.generic': 'Algo deu errado.',
  },
};

let lang = 'en';

export function setLang(next) {
  lang = LANGS.includes(next) ? next : 'en';
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
}

export function getLang() {
  return lang;
}

// t('learn.level', { db: -21 }) -> "level -21 dB"
export function t(key, vars = {}) {
  const str = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function has(key) {
  return key in STRINGS.en;
}

// Fills every element that has data-i18n (text) or data-i18n-* (attributes).
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
}
