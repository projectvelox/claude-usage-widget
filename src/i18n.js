const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const DEFAULT_LANG = 'en';

let _cache = null;

function loadAll() {
  if (_cache) return _cache;
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(LOCALES_DIR);
  } catch (e) {
    // Packaged build with no locales/ folder shouldn't happen given the
    // electron-builder `files` allowlist includes locales/**, but if it does
    // we still want the app to launch with at least an empty registry —
    // every t() call will fall through to the key itself.
    console.error('Locales directory not readable:', e);
    _cache = { translations: {}, available: [DEFAULT_LANG] };
    return _cache;
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const code = file.replace(/\.json$/, '');
    try {
      const raw = fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8');
      out[code] = JSON.parse(raw);
    } catch (e) {
      console.error(`Failed to load locale ${file}:`, e);
    }
  }
  if (!out[DEFAULT_LANG]) {
    // Without English the fallback chain has nothing to fall back to.
    throw new Error('locales/en.json is required and could not be loaded');
  }
  const available = Object.keys(out)
    .map((code) => ({
      code,
      name: out[code]._meta?.name || code,
      nativeName: out[code]._meta?.nativeName || out[code]._meta?.name || code,
      machineTranslated: !!out[code]._meta?.machineTranslated,
    }))
    .sort((a, b) => (a.code === DEFAULT_LANG ? -1 : b.code === DEFAULT_LANG ? 1 : a.name.localeCompare(b.name)));
  _cache = { translations: out, available };
  return _cache;
}

function resolve(lang) {
  const { translations } = loadAll();
  if (translations[lang]) return lang;
  // Try the language family (e.g. "pt-BR" -> "pt") before falling back to en.
  if (typeof lang === 'string' && lang.includes('-')) {
    const base = lang.split('-')[0];
    if (translations[base]) return base;
  }
  return DEFAULT_LANG;
}

function format(template, params) {
  if (!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
  );
}

function makeT(lang) {
  const { translations } = loadAll();
  const resolved = resolve(lang);
  const primary = translations[resolved] || {};
  const fallback = translations[DEFAULT_LANG] || {};
  return function t(key, params) {
    // English text in the source code is the third fallback, so a brand-new
    // key shipped without a translation still renders as the key string
    // rather than as a literal "{key}" debug placeholder.
    const value = key in primary ? primary[key] : (key in fallback ? fallback[key] : key);
    return format(value, params);
  };
}

function bundleFor(lang) {
  const { translations, available } = loadAll();
  const resolved = resolve(lang);
  return {
    lang: resolved,
    requested: lang,
    available,
    translations: translations[resolved] || {},
    fallback: translations[DEFAULT_LANG] || {},
  };
}

function availableLanguages() {
  return loadAll().available;
}

// Test-only: clear the cached load so tests can mutate the locales directory
// between cases without process restart. Not part of the public API surface.
function _resetCache() { _cache = null; }

module.exports = { makeT, bundleFor, availableLanguages, resolve, DEFAULT_LANG, _resetCache };
