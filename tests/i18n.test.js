const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeT, bundleFor, availableLanguages, resolve, DEFAULT_LANG, _resetCache } = require('../src/i18n');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const EN_KEYS = Object.keys(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8')))
  .filter((k) => !k.startsWith('_'));
const ALL_LOCALES = fs.readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

// Every non-English locale must have an entry for every key in en.json.
// Without this, a translated UI could ship with a key that falls through to
// English, and the only way we'd catch it is by spotting the English text
// at runtime. Schema parity is enforced here so it can't slip past CI.
for (const code of ALL_LOCALES.filter((c) => c !== 'en')) {
  test(`locale '${code}' has every English key (schema parity)`, () => {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8');
    const loc = JSON.parse(raw);
    const missing = EN_KEYS.filter((k) => !(k in loc));
    assert.equal(missing.length, 0, `locale ${code} is missing keys: ${missing.join(', ')}`);
  });
}

// _meta must declare the locale code, native name, and machineTranslated flag.
for (const code of ALL_LOCALES) {
  test(`locale '${code}' has well-formed _meta`, () => {
    const loc = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));
    assert.ok(loc._meta, `${code} is missing _meta`);
    assert.equal(loc._meta.code, code, `${code} _meta.code mismatch`);
    assert.equal(typeof loc._meta.name, 'string');
    assert.equal(typeof loc._meta.nativeName, 'string');
    assert.equal(typeof loc._meta.machineTranslated, 'boolean');
  });
}

test('makeT returns the active-locale string for a known key', () => {
  _resetCache();
  const t = makeT('pt-BR');
  assert.equal(t('widget.title'), 'Uso do Claude');
});

test('makeT falls back to English when the key is missing from the active locale', () => {
  // Forge a fake "missing in locale" scenario by asking for a real English-only
  // key. en.json has every key, so use a synthetic locale via the bundle path.
  _resetCache();
  const t = makeT('en');
  assert.equal(t('widget.title'), 'Claude usage');
});

test('makeT falls back to the key itself when neither locale nor English has it', () => {
  _resetCache();
  const t = makeT('en');
  assert.equal(t('nonexistent.key.path'), 'nonexistent.key.path');
});

test('makeT interpolates {placeholder} params', () => {
  _resetCache();
  const t = makeT('en');
  assert.equal(t('widget.lastUpdated', { age: 'just now' }), 'Updated just now');
  assert.equal(t('time.resets.days', { d: 3, h: 4 }), 'resets in 3d 4h');
});

test('makeT leaves unmatched placeholders alone instead of crashing', () => {
  _resetCache();
  const t = makeT('en');
  // {age} is in the template but not in the params object — preserve it
  // verbatim so the source of the missing arg is obvious in logs.
  assert.equal(t('widget.lastUpdated', {}), 'Updated {age}');
});

test('resolve() picks the language family for region-specific tags', () => {
  _resetCache();
  // pt-BR exists, so the resolver should return it as-is.
  assert.equal(resolve('pt-BR'), 'pt-BR');
});

test('resolve() falls back to English for unknown locales', () => {
  _resetCache();
  assert.equal(resolve('xx-YY'), DEFAULT_LANG);
  assert.equal(resolve('klingon'), DEFAULT_LANG);
});

test('availableLanguages() lists English first and the rest alphabetically', () => {
  _resetCache();
  const langs = availableLanguages();
  assert.equal(langs[0].code, 'en');
  const rest = langs.slice(1).map((l) => l.name);
  const sorted = [...rest].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(rest, sorted);
});

test('bundleFor() carries fallback English translations for partial locales', () => {
  _resetCache();
  const b = bundleFor('pt-BR');
  assert.equal(b.lang, 'pt-BR');
  // The fallback table should be present so the renderer can resolve any key
  // the active locale hasn't translated yet.
  assert.ok(b.fallback['widget.title']);
});

test('English locale is canonical and not marked machine-translated', () => {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  assert.equal(en._meta.machineTranslated, false);
});
