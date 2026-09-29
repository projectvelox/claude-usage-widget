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
  { id: 'customFontFamily', path: ['customFontFamily'], type: 'value' },
  { id: 'blur', path: ['blur'], type: 'checked' },
  { id: 'trayIconStyle', path: ['trayIconStyle'], type: 'value' },
  { id: 'pillDisplayMode', path: ['pillDisplayMode'], type: 'value' },
  { id: 'pillDisplayLimitId', path: ['pillDisplayLimitId'], type: 'value' },
  { id: 'pillCycleIntervalSec', path: ['pillCycleIntervalSec'], type: 'number' },
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

// On macOS Claude Code stores the OAuth token in the login Keychain, not in
// ~/.claude/.credentials.json. Swap the About-panel description and the
// "Open credentials file" button label with Keychain-flavored copy so
// nothing in the UI is contradicting reality. Called after each language
// switch so the platform-specific strings re-translate too.
// The "Which limit" and "Cycle every" rows are only meaningful for two of
// the three pill-display modes. Hide the one that isn't in play so the
// panel doesn't ask the user to fill in a value that will be ignored.
function applyPillRowVisibility() {
  const mode = $('pillDisplayMode')?.value || 'worst';
  const limitRow = $('pillDisplayLimitIdRow');
  const cycleRow = $('pillCycleIntervalSecRow');
  if (limitRow) limitRow.hidden = mode !== 'specific';
  if (cycleRow) cycleRow.hidden = mode !== 'cycle';
}

const REPO_URL = 'https://github.com/projectvelox/claude-usage-widget/';

// The font-name row only matters for the "Custom" choice. The status line
// under it tells the user whether the typed family was found — when it
// isn't, the CSS stack silently falls back to the system default, which
// otherwise looks like the setting did nothing.
function applyCustomFontUi() {
  const custom = $('fontFamily')?.value === 'custom';
  const row = $('customFontFamilyRow');
  const status = $('customFontStatus');
  if (row) row.hidden = !custom;
  if (!status) return;
  const name = window.fontUtil.sanitizeFamily($('customFontFamily')?.value);
  if (!custom || !name) { status.hidden = true; return; }
  const found = window.fontUtil.isInstalled(name);
  status.hidden = false;
  status.textContent = t(found ? 'settings.customFont.found' : 'settings.customFont.missing', { name });
  status.classList.toggle('missing', !found);
}

// The settings panel uses the same font as the widget so the choice is
// previewed right where it's made.
function applySettingsFont() {
  window.fontUtil.applyTo(document.documentElement, cfg);
}

// Autocomplete from installed fonts. queryLocalFonts() needs a user gesture,
// so fill the datalist on the first interaction with the field rather than
// at load. Typing a name still works when the API isn't available.
let fontListRequested = false;
async function loadInstalledFonts() {
  if (fontListRequested) return;
  fontListRequested = true;
  const families = await window.fontUtil.listInstalled();
  const list = $('installedFonts');
  if (!list || families.length === 0) return;
  list.replaceChildren(...families.map((f) => {
    const opt = document.createElement('option');
    opt.value = f;
    return opt;
  }));
}

function applyPlatformCopy() {
  if (window.api?.platform !== 'darwin') return;
  const desc = $('aboutDesc');
  if (desc) window.i18n.renderRichInto(desc, t('settings.about.desc.keychain'));
  const btn = $('openCreds');
  if (btn) btn.textContent = t('settings.openCreds.keychain');
}

async function init() {
  await window.i18n.init();
  populateLanguageSelect();
  applyPlatformCopy();
  // Re-render dynamic strings (update status, language list, platform
  // copy) when the user switches language so the panel flips without a
  // relaunch.
  window.i18n.onChange(() => {
    populateLanguageSelect();
    if (cfg) { $('language').value = cfg.language || 'en'; }
    window.api.getUpdate?.().then(renderUpdateStatus);
    applyPlatformCopy();
    applyCustomFontUi();
  });

  cfg = await window.api.getConfig();
  load();
  applyPillRowVisibility();
  applyCustomFontUi();
  applySettingsFont();
  for (const b of BINDINGS) {
    const el = $(b.id);
    if (!el) continue;
    el.addEventListener('input', scheduleSave);
    el.addEventListener('change', scheduleSave);
  }
  $('pillDisplayMode')?.addEventListener('change', applyPillRowVisibility);
  $('fontFamily')?.addEventListener('change', applyCustomFontUi);
  const customFont = $('customFontFamily');
  customFont?.addEventListener('input', applyCustomFontUi);
  customFont?.addEventListener('pointerdown', loadInstalledFonts);
  customFont?.addEventListener('keydown', loadInstalledFonts);
  $('openCreds').addEventListener('click', () => window.api.openCreds());
  $('quit').addEventListener('click', () => window.api.quit());
  $('openRepo')?.addEventListener('click', () => window.api.openExternal(REPO_URL));
  $('reportIssue')?.addEventListener('click', () => window.api.openExternal(`${REPO_URL}issues/new/choose`));
  window.api.onConfig((newCfg) => {
    cfg = newCfg;
    // Don't clobber the font-name field mid-typing: config:changed echoes
    // back after every debounced save and would reset the caret.
    const typing = document.activeElement === customFont;
    const typed = customFont?.value;
    load();
    if (typing) customFont.value = typed;
    applyPillRowVisibility();
    applyCustomFontUi();
    applySettingsFont();
  });

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
