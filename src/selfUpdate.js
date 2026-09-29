// Installs an update the user accepted from the "update available" prompt.
//
//   installer (NSIS setup.exe) / AppImage — electron-updater downloads the new
//     build from our GitHub release (via latest.yml / latest-linux.yml) and
//     restarts into it.
//   portable EXE — a running portable can't overwrite itself, so download the
//     new portable next to the current one, verify it against the release's
//     SHA256SUMS.txt, launch it, and quit. The new copy deletes the old file
//     once it has exited (see cleanupReplacedPortable).
//   anything else (dev run, unsigned macOS) — open the release page.

const { app, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_BASE = 'https://github.com/projectvelox/claude-usage-widget/releases/download';
const PORTABLE_NAME_RE = /^ClaudeUsageWidget-\d+\.\d+\.\d+-portable\.exe$/i;
const REPLACE_FLAG = '--replace-portable=';

function installKind() {
  if (!app.isPackaged) return 'none';
  // electron-builder's portable launcher sets these for the extracted app.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (process.platform === 'win32') return 'installer';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage';
  return 'none';
}

// Expected hash for `fileName` from a SHA256SUMS.txt body ("<hex>  <name>").
function expectedHash(sumsText, fileName) {
  for (const line of String(sumsText).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

async function viaElectronUpdater(onProgress) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const progress = (p) => onProgress(Math.round(p.percent || 0));
  autoUpdater.on('download-progress', progress);
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) throw new Error('No update found in latest.yml');
    await autoUpdater.downloadUpdate();
  } finally {
    autoUpdater.removeListener('download-progress', progress);
  }
  onProgress(100, 'restarting');
  app.isQuitting = true;
  // Silent install, relaunch the app afterwards.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

async function viaPortableSwap(version, onProgress) {
  const currentFile = process.env.PORTABLE_EXECUTABLE_FILE;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(currentFile);
  const fileName = `ClaudeUsageWidget-${version}-portable.exe`;
  const dest = path.join(dir, fileName);
  const base = `${DOWNLOAD_BASE}/v${version}`;

  const sumsRes = await fetch(`${base}/SHA256SUMS.txt`);
  if (!sumsRes.ok) throw new Error(`SHA256SUMS.txt: HTTP ${sumsRes.status}`);
  const expected = expectedHash(await sumsRes.text(), fileName);
  if (!expected) throw new Error(`${fileName} missing from SHA256SUMS.txt`);

  const res = await fetch(`${base}/${fileName}`);
  if (!res.ok || !res.body) throw new Error(`${fileName}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const partial = `${dest}.partial`;
  const out = fs.createWriteStream(partial);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastPct = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw e;
  }
  if (hash.digest('hex') !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error('Downloaded file failed the SHA-256 check');
  }
  fs.renameSync(partial, dest);

  onProgress(100, 'restarting');
  const child = spawn(dest, [`${REPLACE_FLAG}${currentFile}`], { detached: true, stdio: 'ignore' });
  child.unref();
  app.isQuitting = true;
  app.quit();
}

// Returns a promise that settles when the update has been handed off (the
// app is about to quit) or rejects on failure. onProgress(percent, phase).
async function installUpdate(info, onProgress = () => {}) {
  const kind = installKind();
  if (kind === 'installer' || kind === 'appimage') return viaElectronUpdater(onProgress);
  if (kind === 'portable') return viaPortableSwap(info.latestVersion, onProgress);
  shell.openExternal(info.releaseUrl);
  return null;
}

// Called at startup. When launched by an older portable's update, delete that
// older EXE once it has exited. Only touches files that look like our own
// release artifacts, and never the running file.
function cleanupReplacedPortable(argv = process.argv) {
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(REPLACE_FLAG));
  if (!arg) return;
  const oldFile = arg.slice(REPLACE_FLAG.length);
  const self = process.env.PORTABLE_EXECUTABLE_FILE || '';
  if (!oldFile || !PORTABLE_NAME_RE.test(path.basename(oldFile))) return;
  if (path.resolve(oldFile).toLowerCase() === path.resolve(self).toLowerCase()) return;
  let tries = 0;
  const attempt = () => {
    try {
      fs.rmSync(oldFile, { force: true });
    } catch {
      // Still locked while the old process shuts down — retry for ~1 minute.
      if (++tries < 30) setTimeout(attempt, 2_000);
    }
  };
  setTimeout(attempt, 2_000);
}

module.exports = { installKind, installUpdate, cleanupReplacedPortable, expectedHash, PORTABLE_NAME_RE };
