// Font helpers shared by the widget and settings windows. Resolves the
// configured font (preset or user-typed "custom" family) into a CSS stack,
// and checks whether a typed family is actually installed so the settings
// panel can tell the user before they wonder why nothing changed.
(function () {
  const DEFAULT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  // Family names are user-typed and end up inside a CSS custom property.
  // Strip anything that could break out of the quoted string or the
  // declaration; real font names never need these characters.
  function sanitizeFamily(name) {
    return String(name || '').replace(/["'`\\;{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  // Returns the CSS font-family value for this config, or null for the
  // built-in default (callers remove their override in that case).
  function stackFor(cfg) {
    if (!cfg || !cfg.fontFamily || cfg.fontFamily === 'system') return null;
    if (cfg.fontFamily === 'custom') {
      const name = sanitizeFamily(cfg.customFontFamily);
      return name ? `"${name}", ${DEFAULT_STACK}` : null;
    }
    return cfg.fontFamily;
  }

  // No web API reports "is this system font installed", so measure a sample
  // string in the candidate font against each generic fallback. If the width
  // differs from the fallback for any of them, the browser found the font.
  // Checking three generics covers fonts that happen to BE a generic default
  // (e.g. Consolas is Chromium's monospace on Windows).
  function isInstalled(name) {
    const family = sanitizeFamily(name);
    if (!family) return false;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return true; // can't tell — don't nag
    const sample = 'mmmmmmmmmmlli1WQ@#0O';
    return ['monospace', 'serif', 'sans-serif'].some((base) => {
      ctx.font = `72px ${base}`;
      const baseline = ctx.measureText(sample).width;
      ctx.font = `72px "${family}", ${base}`;
      return ctx.measureText(sample).width !== baseline;
    });
  }

  // Installed families via the Local Font Access API, for autocomplete.
  // Chromium only allows the call during a user gesture, and it may be
  // unavailable entirely — resolve to [] in every failure case.
  async function listInstalled() {
    if (typeof window.queryLocalFonts !== 'function') return [];
    try {
      const fonts = await window.queryLocalFonts();
      return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  function applyTo(el, cfg) {
    const stack = stackFor(cfg);
    if (stack) el.style.setProperty('--font-family', stack);
    else el.style.removeProperty('--font-family');
  }

  window.fontUtil = { DEFAULT_STACK, sanitizeFamily, stackFor, isInstalled, listInstalled, applyTo };
})();
