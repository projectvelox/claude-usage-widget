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

  // Safe rich-text renderer. Only `<code>...</code>` from the translated
  // string is honored as an element — everything else is inserted as a text
  // node, which auto-escapes. No innerHTML anywhere, no attribute parsing,
  // no nested tags: `<code>` content itself is matched non-greedily and
  // anything inside becomes textContent on the created element.
  //
  // This is the sink that would matter if the widget ever grew a "load a
  // community translation from a URL" feature. Right now every string in
  // this sink comes from locales/*.json (shipped in the asar bundle), so
  // exploitability is theoretical — but the pattern used to be
  // `el.innerHTML = t(...)`, which CodeQL flagged as js/xss-through-dom
  // because it would trivially become exploitable if the source of t()
  // ever changed.
  function renderRichInto(el, str) {
    while (el.firstChild) el.removeChild(el.firstChild);
    const raw = String(str == null ? '' : str);
    const re = /<code>([^<]*)<\/code>/g;
    let last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) el.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const c = document.createElement('code');
      c.textContent = m[1];
      el.appendChild(c);
      last = re.lastIndex;
    }
    if (last < raw.length) el.appendChild(document.createTextNode(raw.slice(last)));
  }

  // Walk the DOM and translate static markers. Three attribute conventions:
  //   data-i18n="key"           replaces textContent
  //   data-i18n-html="key"      replaces content using the safe rich-text
  //                             renderer (only <code>text</code> honored)
  //   data-i18n-attr="title:key,placeholder:key"  sets named attributes
  function applyDom(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      renderRichInto(el, t(el.getAttribute('data-i18n-html')));
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

  window.i18n = { t, lang, available, applyDom, renderRichInto, init, onChange };
})();
