const $ = (id) => document.getElementById(id);
const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
let cfg = null;
let saveTimer = null;

const BINDINGS = [
  { id: 'language', path: ['language'], type: 'value' },
  { id: 'layout', path: ['layout'], type: 'value' },
  { id: 'alwaysOnTop', path: ['alwaysOnTop'], type: 'checked' },
  { id: 'clickThrough', path: ['clickThrough'], type: 'checked' },
  { id: 'showHeader', path: ['showHeader'], type: 'checked' },
  { id: 'showResetCountdown', path: ['showResetCountdown'], type: 'checked' },
  { id: 'showPaceMarker', path: ['showPaceMarker'], type: 'checked' },
  { id: 'showStaleIndicator', path: ['showStaleIndicator'], type: 'checked' },
  { id: 'showMascot', path: ['showMascot'], type: 'checked' },
  { id: 'theme', path: ['theme'], type: 'value' },
  { id: 'accentColor', path: ['accentColor'], type: 'value' },
  { id: 'opacity', path: ['opacity'], type: 'number', display: 'opacityVal', fmt: (v) => v.toFixed(2) },
  { id: 'cornerRadius', path: ['cornerRadius'], type: 'number', display: 'cornerRadiusVal', fmt: (v) => `${v}px` },
  { id: 'fontScale', path: ['fontScale'], type: 'number', display: 'fontScaleVal', fmt: (v) => `${Math.round(v * 100)}%` },
  { id: 'fontFamily', path: ['fontFamily'], type: 'value' },
  { id: 'blur', path: ['blur'], type: 'checked' },
  { id: 'trayIconStyle', path: ['trayIconStyle'], type: 'value' },
  { id: 'showHistoryGraph', path: ['showHistoryGraph'], type: 'checked' },
  { id: 'historyLimitId', path: ['historyLimitId'], type: 'value' },
  { id: 'warn', path: ['thresholds', 'warn'], type: 'number' },
  { id: 'critical', path: ['thresholds', 'critical'], type: 'number' },
  { id: 'okColor', path: ['colors', 'ok'], type: 'value' },
  { id: 'warnColor', path: ['colors', 'warn'], type: 'value' },
  { id: 'criticalColor', path: ['colors', 'critical'], type: 'value' },
  { id: 'notifyAtWarn', path: ['notifyAtWarn'], type: 'checked' },
  { id: 'notifyAtCritical', path: ['notifyAtCritical'], type: 'checked' },
  { id: 'onReset_five_hour', path: ['onReset', 'five_hour'], type: 'value' },
  { id: 'onReset_seven_day', path: ['onReset', 'seven_day'], type: 'value' },
  { id: 'onReset_seven_day_sonnet', path: ['onReset', 'seven_day_sonnet'], type: 'value' },
  { id: 'onReset_seven_day_opus', path: ['onReset', 'seven_day_opus'], type: 'value' },
  { id: 'openAtLogin', path: ['openAtLogin'], type: 'checked' },
  { id: 'openMinimized', path: ['openMinimized'], type: 'checked' },
  { id: 'checkForUpdates', path: ['checkForUpdates'], type: 'checked' },
];

function getPath(obj, path) {
  return path.reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

function load() {
  for (const b of BINDINGS) {
    const el = $(b.id);
    if (!el) continue;
    const val = getPath(cfg, b.path);
    if (b.type === 'checked') el.checked = !!val;
    else if (b.type === 'number') el.value = (val == null) ? '' : String(val);
    else el.value = val ?? '';
    if (b.display) $(b.display).textContent = b.fmt ? b.fmt(Number(val)) : String(val);
  }
}

function readForm() {
  const patch = {};
  for (const b of BINDINGS) {
    const el = $(b.id);
    if (!el) continue;
    let value;
    if (b.type === 'checked') value = el.checked;
    else if (b.type === 'number') value = Number(el.value);
    else value = el.value;
    setPath(patch, b.path, value);
    if (b.display) $(b.display).textContent = b.fmt ? b.fmt(Number(el.value)) : String(el.value);
  }
  return patch;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = readForm();
    cfg = await window.api.updateConfig(patch);
  }, 120);
}

function populateLanguageSelect() {
  const sel = $('language');
  if (!sel) return;
  const available = window.i18n?.available() || [];
  sel.innerHTML = '';
  for (const loc of available) {
    const opt = document.createElement('option');
    opt.value = loc.code;
    // Show "Español (Spanish) *" — native name first since that's what a
    // speaker recognizes at a glance; English in parens helps anyone who
    // mis-clicked and needs to recognize "their" language to switch back.
    // Asterisk flags machine-assisted translations so users know to expect
    // rough edges and to file PRs.
    const flag = loc.machineTranslated ? ' *' : '';
    const label = loc.nativeName === loc.name ? loc.nativeName : `${loc.nativeName} (${loc.name})`;
    opt.textContent = `${label}${flag}`;
    sel.appendChild(opt);
  }
}

function renderUpdateStatus(info) {
  const status = $('updateStatus');
  if (!status) return;
  if (!info) { status.textContent = t('settings.updateStatus.neverChecked'); return; }
  if (info.available) status.textContent = t('settings.updateStatus.available', { version: info.latestVersion });
  else if (info.latestVersion) status.textContent = t('settings.updateStatus.latest', { version: info.latestVersion });
  else status.textContent = '';
}

async function init() {
  await window.i18n.init();
  populateLanguageSelect();
  // Re-render dynamic strings (update status, language list) when the user
  // switches language so the panel flips without a relaunch.
  window.i18n.onChange(() => {
    populateLanguageSelect();
    if (cfg) { $('language').value = cfg.language || 'en'; }
    window.api.getUpdate?.().then(renderUpdateStatus);
  });

  cfg = await window.api.getConfig();
  load();
  for (const b of BINDINGS) {
    const el = $(b.id);
    if (!el) continue;
    el.addEventListener('input', scheduleSave);
    el.addEventListener('change', scheduleSave);
  }
  $('openCreds').addEventListener('click', () => window.api.openCreds());
  $('quit').addEventListener('click', () => window.api.quit());
  window.api.onConfig((newCfg) => { cfg = newCfg; load(); });

  const checkBtn = $('checkUpdateNow');
  const status = $('updateStatus');
  if (checkBtn && status) {
    window.api.getUpdate?.().then(renderUpdateStatus);
    window.api.onUpdate?.(renderUpdateStatus);
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      status.textContent = t('settings.checking');
      try { await window.api.checkUpdate?.(); } finally { checkBtn.disabled = false; }
    });
  }
}

init();
