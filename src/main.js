const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, powerMonitor, Notification, shell, nativeTheme, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');
const { deepMerge } = require('./config');
const { Poller } = require('./poller');
const { History } = require('./history');
const icon = require('./icon');
const { checkForUpdate, CHECK_INTERVAL_MS } = require('./updater');
const { isOnAnyDisplay } = require('./geom');
const { makeT, bundleFor } = require('./i18n');

// Single t() bound to the current language. Rebuilt whenever the user switches
// languages so tray/dialog/notification text refreshes without a relaunch.
let t = (key, params) => key;

let widgetWindow = null;
let settingsWindow = null;
let tray = null;
let poller = null;
let cfg = null;
let history = null;
let lastUsage = null;
let lastError = null;
let activityState = 'active';
let notifiedFor = new Set();
let lastUpdateInfo = null;
let updateTimer = null;

// "Is this rect on any currently-connected display?" — used to detect a
// stranded widget after the user unplugs a monitor it was pinned to.
function isOnVisibleDisplay(rect) {
  return isOnAnyDisplay(rect, screen.getAllDisplays());
}

// Transparent padding the window carries around the widget so its drop shadow
// renders in full (and rounded) instead of being clipped square at the window
// edge. Must match the .widget margin in widget.css.
const SHADOW_GUTTER = 24;

function defaultCorner(width) {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - width - 24, y: workArea.y + 24 };
}

// Snaps the widget back to the primary monitor's top-right if its current
// bounds are completely off-screen. Triggered on startup (createWidget clamps
// the saved position) and at runtime on display-removed / metrics-changed.
function rescueWindowIfOrphaned() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const [x, y] = widgetWindow.getPosition();
  const [width, height] = widgetWindow.getSize();
  if (isOnVisibleDisplay({ x, y, width, height })) return;
  const safe = defaultCorner(width);
  widgetWindow.setBounds({ x: safe.x, y: safe.y, width, height });
  cfg.position = { x: safe.x, y: safe.y };
  config.save(cfg);
}

function createWidget() {
  const isMinimal = cfg.layout === 'minimal';
  const width = isMinimal ? 156 : cfg.size.width + SHADOW_GUTTER * 2;
  const height = isMinimal ? 44 : 320;
  const fallback = defaultCorner(width);
  const savedX = cfg.position.x;
  const savedY = cfg.position.y;
  const hasSaved = savedX != null && savedY != null;
  const savedRect = hasSaved ? { x: savedX, y: savedY, width, height } : null;
  const usable = hasSaved && isOnVisibleDisplay(savedRect);
  const x = usable ? savedX : fallback.x;
  const y = usable ? savedY : fallback.y;
  // If we just rescued an orphaned position, persist the rescue so the next
  // launch doesn't try the dead coords again.
  if (hasSaved && !usable) { cfg.position = { x, y }; config.save(cfg); }

  widgetWindow = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: cfg.alwaysOnTop,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widgetWindow.setOpacity(cfg.opacity);
  widgetWindow.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });

  if (cfg.alwaysOnTop) {
    widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  widgetWindow.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'));
  widgetWindow.once('ready-to-show', () => widgetWindow.show());

  // 'moved' fires for every pixel of a drag. Persisting synchronously to disk
  // on each event blocks the main thread mid-drag and makes the widget feel
  // stuck or unclickable. Debounce so we only write once the user lets go.
  let moveSaveTimer = null;
  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const [nx, ny] = widgetWindow.getPosition();
    cfg.position = { x: nx, y: ny };
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => { moveSaveTimer = null; config.save(cfg); }, 800);
  });

  widgetWindow.on('closed', () => {
    // Cancel any in-flight position save — without this, a debounced save can
    // fire after `widgetWindow` is null and overwrite a no-longer-relevant
    // position to disk.
    if (moveSaveTimer) { clearTimeout(moveSaveTimer); moveSaveTimer = null; }
    widgetWindow = null;
  });
}

function createSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 540,
    height: 760,
    title: 'Claude Usage Widget — Settings',
    backgroundColor: '#1a1a1d',
    resizable: true,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function worstLimitContext() {
  // Drives the live fill/tint for battery, gauge, minimal, and dynamic.
  // Returns null when there's no data yet — callers should fall back to a
  // sensible default fill so the icon doesn't render as a hollow outline.
  if (!lastUsage || !Array.isArray(lastUsage.limits) || lastUsage.limits.length === 0) return null;
  const worst = lastUsage.limits.reduce((a, b) => (a.utilization > b.utilization ? a : b));
  const pct = worst.utilization;
  const severity = (() => {
    if (pct >= cfg.thresholds.critical) return cfg.colors.critical;
    if (pct >= cfg.thresholds.warn) return cfg.colors.warn;
    return cfg.colors.ok;
  })();
  const hex = severity.replace('#', '');
  return {
    pct,
    severity: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255],
  };
}

function makeTrayIconImage() {
  // 32px primary + 64px for 2x DPI displays.
  // Bars is a pure decoration glyph; everything else reflects the live worst
  // limit. Until the first poll lands, fall back to a nominal fill so the
  // shapes read as real icons rather than empty outlines.
  const style = cfg.trayIconStyle || 'bars';
  const ctx = worstLimitContext();
  const opts = { accent: cfg.accentColor };
  if (ctx) { opts.pct = ctx.pct; opts.severity = ctx.severity; }
  else if (style === 'battery' || style === 'gauge') { opts.pct = 50; }
  let canvas32, canvas64;
  if (style === 'dynamic') {
    canvas32 = icon.drawDynamic(32, lastUsage, cfg);
    canvas64 = icon.drawDynamic(64, lastUsage, cfg);
  } else {
    canvas32 = icon.draw(style, 32, opts);
    canvas64 = icon.draw(style, 64, opts);
  }
  const png32 = icon.encodePNG(canvas32.w, canvas32.h, canvas32.buf);
  const png64 = icon.encodePNG(canvas64.w, canvas64.h, canvas64.buf);
  const img = nativeImage.createFromBuffer(png32);
  img.addRepresentation({ scaleFactor: 2, buffer: png64, width: 64, height: 64 });
  return img;
}

function createTray() {
  tray = new Tray(makeTrayIconImage());
  tray.setToolTip(t('tray.tooltip'));
  rebuildTrayMenu();
  tray.on('click', () => {
    if (!widgetWindow) createWidget();
    else widgetWindow.isVisible() ? widgetWindow.hide() : widgetWindow.show();
  });
}

function refreshTrayIcon() {
  if (!tray) return;
  try { tray.setImage(makeTrayIconImage()); } catch (e) { console.error('Tray icon refresh failed:', e); }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const styleSubmenu = ['bars', 'battery', 'gauge', 'minimal', 'dynamic'].map((s) => ({
    label: t(`tray.style.${s}`),
    type: 'radio',
    checked: cfg.trayIconStyle === s,
    click: () => {
      cfg.trayIconStyle = s;
      refreshTrayIcon();
      config.save(cfg);
      broadcast('config:changed', cfg);
    },
  }));
  const menu = Menu.buildFromTemplate([
    { label: t('tray.show'), click: () => { if (!widgetWindow) createWidget(); else widgetWindow.show(); } },
    { label: t('tray.hide'), click: () => widgetWindow?.hide() },
    { type: 'separator' },
    { label: t('tray.refresh'), click: () => poller?.manualRefresh() },
    { label: t('tray.settings'), click: createSettings },
    { type: 'separator' },
    { label: t('tray.iconStyle'), submenu: styleSubmenu },
    {
      label: t('tray.alwaysOnTop'),
      type: 'checkbox',
      checked: cfg.alwaysOnTop,
      click: (item) => { cfg.alwaysOnTop = item.checked; widgetWindow?.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver'); config.save(cfg); },
    },
    {
      label: t('tray.clickThrough'),
      type: 'checkbox',
      checked: cfg.clickThrough,
      click: async (item) => {
        if (item.checked && !cfg.clickThrough) {
          const ok = await confirmEnableClickThrough();
          if (!ok) { rebuildTrayMenu(); return; }
        }
        cfg.clickThrough = item.checked;
        widgetWindow?.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
        config.save(cfg);
        broadcast('config:changed', cfg);
      },
    },
    {
      label: t('tray.startWithWindows'),
      type: 'checkbox',
      checked: cfg.openAtLogin,
      click: (item) => { cfg.openAtLogin = item.checked; syncLoginItem(); config.save(cfg); broadcast('config:changed', cfg); },
    },
    { type: 'separator' },
    {
      label: lastUpdateInfo?.available
        ? t('tray.getUpdate', { latest: lastUpdateInfo.latestVersion, current: app.getVersion() })
        : t('tray.checkUpdate'),
      click: () => {
        if (lastUpdateInfo?.available && lastUpdateInfo.releaseUrl) {
          shell.openExternal(lastUpdateInfo.releaseUrl);
        } else {
          runUpdateCheck({ manual: true });
        }
      },
    },
    {
      label: t('tray.autoCheck'),
      type: 'checkbox',
      checked: cfg.checkForUpdates !== false,
      click: (item) => {
        cfg.checkForUpdates = item.checked;
        config.save(cfg);
        broadcast('config:changed', cfg);
        scheduleUpdateChecks();
      },
    },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function syncLoginItem() {
  const settings = { openAtLogin: !!cfg.openAtLogin };
  if (!app.isPackaged) {
    settings.path = process.execPath;
    settings.args = [path.resolve(__dirname, '..')];
  }
  app.setLoginItemSettings(settings);
}

function broadcast(channel, payload) {
  for (const win of [widgetWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function localizedLimitLabel(limit) {
  if (!limit) return '';
  const key = `limit.${limit.id}`;
  const translated = t(key);
  // If the key isn't in the locale (t() falls through to returning the key
  // itself), use whatever label the server / normalizer assigned. That
  // covers future limit ids the widget hasn't been taught yet.
  return translated && translated !== key ? translated : (limit.label || limit.id || '');
}

function checkNotifications(usage) {
  if (!usage || !Array.isArray(usage.limits)) return;
  for (const limit of usage.limits) {
    const pct = limit.utilization;
    const key = `${limit.id}:${limit.resetsAt || ''}`;
    const labelArg = { label: localizedLimitLabel(limit), pct: Math.round(pct) };
    if (cfg.notifyAtCritical && pct >= cfg.thresholds.critical && !notifiedFor.has(key + ':crit')) {
      notify(t('notify.limitAtPct', labelArg), t('notify.critical'));
      notifiedFor.add(key + ':crit');
    } else if (cfg.notifyAtWarn && pct >= cfg.thresholds.warn && pct < cfg.thresholds.critical && !notifiedFor.has(key + ':warn')) {
      notify(t('notify.limitAtPct', labelArg), t('notify.warn'));
      notifiedFor.add(key + ':warn');
    }
    if (pct < cfg.thresholds.warn) {
      notifiedFor.delete(key + ':warn');
      notifiedFor.delete(key + ':crit');
    }
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

async function confirmEnableClickThrough() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [t('dialog.clickThrough.cancel'), t('dialog.clickThrough.confirm')],
    defaultId: 0,
    cancelId: 0,
    title: t('dialog.clickThrough.title'),
    message: t('dialog.clickThrough.message'),
    detail: t('dialog.clickThrough.detail'),
  });
  return response === 1;
}

function runResetHook(reset) {
  const command = cfg.onReset?.[reset.id];
  if (!command || !command.trim()) return;
  try {
    // Pass a minimal environment to the hook command — just the PATH (so common
    // utilities resolve) and the CLAUDE_RESET_* vars we promise in the docs.
    // Inheriting the full Electron process.env would otherwise leak any
    // ANTHROPIC_API_KEY / GH_TOKEN / etc. the user happens to have set.
    const env = {
      PATH: process.env.PATH || process.env.Path || '',
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      CLAUDE_RESET_ID: reset.id,
      CLAUDE_RESET_LABEL: reset.label,
      CLAUDE_RESET_AT: reset.currReset || '',
      CLAUDE_RESET_PREVIOUS_UTIL: String(reset.currUtilization ?? ''),
    };
    const child = spawn(command, [], { shell: true, env, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    console.error('Reset hook failed:', reset.id, e);
  }
}

// Pings GitHub Releases once a day to see if a newer tag exists. The renderer
// shows a discreet "v0.2.11 available" link in the footer when one does — no
// auto-download, since the portable EXE intentionally doesn't self-rewrite.
async function runUpdateCheck({ manual = false } = {}) {
  if (!cfg.checkForUpdates && !manual) return;
  try {
    const info = await checkForUpdate(app.getVersion());
    lastUpdateInfo = info;
    broadcast('update:available', info);
    rebuildTrayMenu();
    if (manual && info && !info.available) {
      notify(t('notify.upToDate.title'), t('notify.upToDate.body', { version: app.getVersion() }));
    }
  } catch (e) {
    // Network blips and 403 rate-limits are expected; surface nothing.
    if (manual) notify(t('notify.updateFailed.title'), e.message || t('notify.updateFailed.body'));
  }
}

function scheduleUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  if (!cfg.checkForUpdates) return;
  // Only fire the deferred-first-check on cold start, not every time the
  // settings panel toggles something — otherwise twiddling the UI would
  // spam the GitHub API. The 24 h interval still gets rebuilt either way.
  if (!lastUpdateInfo) setTimeout(() => runUpdateCheck(), 5_000);
  updateTimer = setInterval(() => runUpdateCheck(), CHECK_INTERVAL_MS);
}

function updateActivityState() {
  const idleSec = powerMonitor.getSystemIdleTime();
  let next;
  if (idleSec > 1800) next = 'locked';
  else if (idleSec > 600) next = 'deepIdle';
  else if (idleSec > 120) next = 'idle';
  else next = 'active';
  if (next !== activityState) {
    const becameActive = next === 'active' && activityState !== 'active';
    activityState = next;
    // Modern Windows standby and "lid open but screen off" states often skip the
    // suspend/resume powerMonitor events. Treat an idle->active transition as a
    // wake so the user sees fresh data the moment they return.
    if (becameActive) poller?.notifyWake();
  }
}

app.whenReady().then(() => {
  cfg = config.load();
  nativeTheme.themeSource = cfg.theme;
  t = makeT(cfg.language || 'en');
  history = new History(config.historyPath());

  syncLoginItem();

  if (cfg.openMinimized) {
    createTray();
  } else {
    createWidget();
    createTray();
  }

  poller = new Poller({
    onUpdate: (data) => {
      lastUsage = data;
      lastError = null;
      history.add(data);
      if (cfg.trayIconStyle !== 'bars') refreshTrayIcon();
      broadcast('usage:update', { data, stale: false, cfg, history: history.samples });
      checkNotifications(data);
    },
    onError: (err, { lastData }) => {
      lastError = { code: err.code || 'ERROR', message: err.message };
      broadcast('usage:error', { error: lastError, lastData, cfg });
    },
    onReset: (reset) => {
      runResetHook(reset);
      broadcast('usage:reset', reset);
    },
    getActivityState: () => activityState,
  });
  poller.start();

  setInterval(updateActivityState, 30_000);
  powerMonitor.on('resume', () => poller?.notifyWake());
  powerMonitor.on('unlock-screen', () => poller?.notifyWake());
  // Recover from "user unplugged the 2nd monitor while the widget was pinned
  // to it." display-removed fires when a monitor disconnects; metrics-changed
  // covers DPI / resolution swaps that can also strand the window.
  screen.on('display-removed', rescueWindowIfOrphaned);
  screen.on('display-metrics-changed', rescueWindowIfOrphaned);
  scheduleUpdateChecks();

  ipcMain.handle('config:get', () => cfg);
  ipcMain.handle('config:update', async (_evt, patch) => {
    // Surface a confirmation when click-through is being turned on, since
    // once it's enabled the widget becomes unclickable and the only recovery
    // path is the tray menu — an easy panic moment for a non-technical user.
    if (patch && patch.clickThrough === true && !cfg.clickThrough) {
      const ok = await confirmEnableClickThrough();
      if (!ok) patch = { ...patch, clickThrough: false };
    }
    const oldStyle = cfg.trayIconStyle;
    const oldAccent = cfg.accentColor;
    cfg = deepMerge(cfg, patch);
    config.save(cfg);
    applyConfig();
    if (cfg.trayIconStyle !== oldStyle || cfg.accentColor !== oldAccent) refreshTrayIcon();
    broadcast('config:changed', cfg);
    return cfg;
  });
  ipcMain.handle('usage:last', () => ({ data: lastUsage, error: lastError, cfg, history: history.samples }));
  ipcMain.handle('usage:refresh', async () => poller.manualRefresh());
  ipcMain.handle('window:drag', (_evt, { dx, dy }) => {
    if (!widgetWindow) return;
    const [x, y] = widgetWindow.getPosition();
    widgetWindow.setPosition(x + dx, y + dy);
  });
  ipcMain.handle('window:resize', (_evt, { h }) => {
    // Renderer measures actual content height (header + limits + optional
    // graph + footer) and asks us to fit. Without this, the window stays at
    // 320px and clips the graph + footer when many limits are present.
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (cfg.layout === 'minimal') return;
    const [wx, wy] = widgetWindow.getPosition();
    const [ww] = widgetWindow.getSize();
    const target = Math.max(120, Math.min(900, Math.round(h)));
    widgetWindow.setBounds({ x: wx, y: wy, width: ww, height: target });
  });
  ipcMain.handle('settings:open', () => createSettings());
  ipcMain.handle('settings:close', () => settingsWindow?.close());
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('window:hide', () => widgetWindow?.hide());
  ipcMain.handle('shell:openCreds', () => {
    // On macOS Claude Code stores the OAuth token in the login Keychain, not
    // in the JSON file — so the "open credentials" button opens Keychain
    // Access instead (users can then search the "Claude Code-credentials"
    // item themselves; Keychain doesn't accept a direct URL for a specific
    // generic-password entry). On every other platform we still open the
    // file the way we always have.
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'Keychain Access'], { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    }
    return shell.openPath(require('./usage').CREDS_PATH);
  });
  ipcMain.handle('shell:openExternal', (_evt, url) => {
    // Whitelist: only open GitHub release pages for this repo. Prevents the
    // renderer from coaxing the main process into opening arbitrary URLs.
    if (typeof url !== 'string') return;
    if (!url.startsWith('https://github.com/projectvelox/claude-usage-widget/')) return;
    shell.openExternal(url);
  });
  ipcMain.handle('update:get', () => lastUpdateInfo);
  ipcMain.handle('update:check', () => runUpdateCheck({ manual: true }));
  ipcMain.handle('i18n:get', () => bundleFor(cfg.language || 'en'));
});

// Pill mode uses a small fixed-size window so it actually feels minimized
// on screen rather than just hiding the body inside a 280x320 transparent box.
const MINIMAL_SIZE = { width: 156, height: 44 };

function applyConfig() {
  syncLoginItem();
  nativeTheme.themeSource = cfg.theme;
  // Rebind t() in case the language changed since the last apply. Tray menu /
  // dialogs / notifications rendered after this call pick up the new strings.
  t = makeT(cfg.language || 'en');
  if (tray) tray.setToolTip(t('tray.tooltip'));
  rebuildTrayMenu();
  scheduleUpdateChecks();
  // Push the new bundle to any open renderer windows so widget + settings UI
  // re-render their static labels immediately, no relaunch required.
  broadcast('i18n:changed', bundleFor(cfg.language || 'en'));
  if (!widgetWindow) return;
  widgetWindow.setOpacity(cfg.opacity);
  widgetWindow.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  widgetWindow.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });

  const [x, y] = widgetWindow.getPosition();
  if (cfg.layout === 'minimal') {
    widgetWindow.setBounds({ x, y, width: MINIMAL_SIZE.width, height: MINIMAL_SIZE.height });
  } else {
    // Only seed a height when coming back from the pill (current height is the
    // 44px minimal box). Otherwise leave height alone — the renderer's
    // ResizeObserver will fit the window to actual content on the next paint.
    const [, curH] = widgetWindow.getSize();
    const height = curH < 120 ? 320 : curH;
    widgetWindow.setBounds({ x, y, width: cfg.size.width + SHADOW_GUTTER * 2, height });
  }
}

// deepMerge moved to config.js — there used to be a second implementation
// here with slightly different semantics (no structuredClone of base, treated
// arrays specially). Two copies meant the same `config:update` patch could
// behave differently depending on which path it went through. The canonical
// version is now imported from config.js (unit-tested in tests/config.test.js).

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') e.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Hygiene: stop background work so quit can complete without dangling
  // timers calling into a half-torn-down app.
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  poller?.stop();
});
