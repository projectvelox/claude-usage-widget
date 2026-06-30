// Renderer-side i18n. The actual translation tables live in the main process
// (in locales/*.json, loaded by src/i18n.js) because sandbox + contextIsolation
// stop the renderer from reading files directly. We fetch the bundle once on
// init via the preload API, then re-fetch when the user changes language.
(function () {
  const STATE = {
    bundle: null,           // { lang, translations, fallback, available }
    listeners: new Set(),   // callbacks fired after a language change
  };

  function format(template, params) {
    if (template == null) return '';
    if (!params) return String(template);
    return String(template).replace(/\{(\w+)\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
    );
  }

  function t(key, params) {
    if (!STATE.bundle) return key;
    const { translations, fallback } = STATE.bundle;
    const value = (key in translations) ? translations[key] : (key in fallback ? fallback[key] : key);
    return format(value, params);
  }

  function lang() { return STATE.bundle?.lang || 'en'; }
  function available() { return STATE.bundle?.available || []; }

  // Walk the DOM and translate static markers. Three attribute conventions:
  //   data-i18n="key"           replaces textContent
  //   data-i18n-html="key"      replaces innerHTML (use for strings that
  //                             intentionally contain <code> etc.)
  //   data-i18n-attr="title:key,placeholder:key"  sets named attributes
  function applyDom(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const spec = el.getAttribute('data-i18n-attr');
      for (const pair of spec.split(',')) {
        const [attr, key] = pair.split(':').map((s) => s && s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    });
  }

  async function init() {
    if (window.api?.getI18n) {
      STATE.bundle = await window.api.getI18n();
      applyDom();
    }
    if (window.api?.onI18n) {
      window.api.onI18n((bundle) => {
        STATE.bundle = bundle;
        applyDom();
        for (const cb of STATE.listeners) {
          try { cb(bundle); } catch (e) { console.error('i18n listener error:', e); }
        }
      });
    }
  }

  function onChange(cb) { STATE.listeners.add(cb); }

  window.i18n = { t, lang, available, applyDom, init, onChange };
})();
