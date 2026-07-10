const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Window
  position: { x: null, y: null },
  size: { width: 280, height: 'auto' },
  alwaysOnTop: true,
  clickThrough: false,
  opacity: 0.96,
  draggable: true,

  // Layout. 'minimal' collapses the widget to a small pill (worst-limit %
  // + colored dot). lastExpandedLayout remembers what to restore when the
  // user un-minimizes from the pill.
  layout: 'expanded',
  lastExpandedLayout: 'expanded',

  // Pill (minimal-mode) display:
  //   'worst'    — show the currently-highest-utilization limit (default)
  //   'specific' — always show pillDisplayLimitId
  //   'cycle'    — rotate through all limits every pillCycleIntervalSec
  pillDisplayMode: 'worst',
  pillDisplayLimitId: 'seven_day',
  pillCycleIntervalSec: 5,
  showHeader: true,
  showResetCountdown: true,
  showPaceMarker: true,
  showHistoryGraph: false,
  showStaleIndicator: true,
  historyLimitId: 'seven_day', // which series to plot
  showMascot: true,            // Claw'd walks along the widget bottom

  // Theme
  theme: 'system',
  accentColor: '#38AEEB',
  fontFamily: 'system',
  fontScale: 1.0,
  cornerRadius: 14,
  blur: true,

  // Thresholds
  thresholds: {
    warn: 75,
    critical: 90,
  },
  colors: {
    ok: '#3DDC84',
    warn: '#F5B400',
    critical: '#E5484D',
  },

  // Notifications
  notifyAtWarn: false,
  notifyAtCritical: true,

  // Behavior
  openAtLogin: false,
  openMinimized: false,
  checkForUpdates: true,

  // Tray icon
  trayIconStyle: 'bars', // bars | battery | gauge | minimal | dynamic

  // Language. 'en' is canonical; other locales fall back to English for any
  // missing keys. Default is English regardless of system locale — users opt
  // in to other languages via Settings.
  language: 'en',

  // Reset hooks: limit id -> shell command. Fires once when that quota's
  // resetsAt advances. Commands run detached; output is discarded.
  onReset: {
    five_hour: '',
    seven_day: '',
    seven_day_sonnet: '',
    seven_day_opus: '',
  },

};

let cachedPath = null;
function configPath() {
  if (cachedPath) return cachedPath;
  cachedPath = path.join(app.getPath('userData'), 'config.json');
  return cachedPath;
}

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function load() {
  const p = configPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Config read failed:', err);
    return structuredClone(DEFAULTS);
  }
  try {
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    // Corrupted JSON (partial write, encoding issue). Move the bad file aside
    // so the next save() doesn't overwrite the user's real settings with
    // defaults — they can recover by hand from the .corrupt sibling.
    console.error('Config parse failed; preserving as .corrupt and using defaults:', err);
    try { fs.renameSync(p, `${p}.corrupt-${Date.now()}`); } catch (e) { console.error('Could not rename corrupt config:', e); }
    return structuredClone(DEFAULTS);
  }
}

function save(cfg) {
  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function deepMerge(base, override) {
  if (override === undefined) return structuredClone(base);
  if (base == null || override == null) return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = (k in override) ? deepMerge(base[k], override[k]) : structuredClone(base[k]);
  }
  for (const k of Object.keys(override)) {
    if (!(k in out)) out[k] = override[k];
  }
  return out;
}

module.exports = { load, save, deepMerge, DEFAULTS, configPath, historyPath };
