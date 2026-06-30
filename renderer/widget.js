const $ = (id) => document.getElementById(id);
const root = $('root');
const limitsEl = $('limits');
const lastUpdatedEl = $('lastUpdated');
const staleBadge = $('staleBadge');
const errorBadge = $('errorBadge');
const statusDot = $('statusDot');
const graphWrap = $('graphWrap');
const graphSvg = $('graph');
const graphEmpty = $('graphEmpty');
const graphTitle = $('graphTitle');
const graphSub = $('graphSub');
const pillDot = $('pillDot');
const pillPct = $('pillPct');
const pillLabel = $('pillLabel');
const updateLink = $('updateLink');

let currentCfg = null;
let lastData = null;
let lastError = null;
let history = [];
let pendingResize = false;
let lastSentHeight = 0;

// "Syncing" and "paused" are soft framings for stale / rate-limited. They're
// only surfaced once the condition has actually persisted long enough to be
// worth a user's attention — sub-minute blips never reach the UI, so a
// non-technical user doesn't get alarmed by transient quirks.
const SOFT_STALE_MS = 5 * 60 * 1000;
const SOFT_THROTTLE_MS = 2 * 60 * 1000;
let staleSince = null;
let throttledSince = null;

// Ask main to fit the window to the actual content height. The expanded layout
// has variable rows (N limits × optional countdown + optional graph + footer),
// so a hardcoded window height clips the bottom. Re-runs whenever the .widget
// box resizes via ResizeObserver below.
function requestFit() {
  if (pendingResize) return;
  pendingResize = true;
  requestAnimationFrame(() => {
    pendingResize = false;
    if (!currentCfg || currentCfg.layout === 'minimal') return;
    const gutter = parseFloat(getComputedStyle(root).marginTop) || 0;
    const h = root.offsetHeight + gutter * 2;
    if (h <= 0 || h === lastSentHeight) return;
    lastSentHeight = h;
    window.api.resize?.(h);
  });
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => requestFit()).observe(root);
}

function applyTheme(cfg) {
  // Layout swaps (minimal <-> expanded) change the window dimensions outside
  // the renderer's knowledge, so clear the cached height to force a refit.
  if (currentCfg && currentCfg.layout !== cfg.layout) lastSentHeight = 0;
  currentCfg = cfg;
  const theme = cfg.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : cfg.theme;
  root.dataset.theme = theme;
  root.dataset.layout = cfg.layout;
  root.classList.toggle('no-blur', !cfg.blur);
  root.classList.toggle('no-header', !cfg.showHeader);
  root.toggleAttribute('data-no-mascot', !cfg.showMascot);

  const ds = document.documentElement.style;
  ds.setProperty('--accent', cfg.accentColor);
  ds.setProperty('--ok', cfg.colors.ok);
  ds.setProperty('--warn', cfg.colors.warn);
  ds.setProperty('--critical', cfg.colors.critical);
  ds.setProperty('--radius', `${cfg.cornerRadius}px`);
  ds.setProperty('--font-scale', cfg.fontScale);
  if (cfg.fontFamily && cfg.fontFamily !== 'system') ds.setProperty('--font-family', cfg.fontFamily);
  else ds.removeProperty('--font-family');
}

function severity(pct, cfg) {
  if (pct >= cfg.thresholds.critical) return 'critical';
  if (pct >= cfg.thresholds.warn) return 'warn';
  return 'ok';
}

// Now we use the actual window length from the data layer (mapped by limit id)
// instead of inferring from time-to-reset. This stays accurate even right after
// a reset moment.
function paceFraction(limit) {
  if (!limit.resetsAt || !limit.windowMs) return null;
  const now = Date.now();
  const reset = new Date(limit.resetsAt).getTime();
  const start = reset - limit.windowMs;
  const elapsed = now - start;
  if (elapsed <= 0) return 0;
  return Math.max(0, Math.min(1, elapsed / limit.windowMs));
}

// Renders the dollar facts attached to a credit-pool limit (the API exposes
// `used_credits`, `monthly_limit`, `currency` for the extra_usage entry).
// Returns empty string if the limit doesn't carry credit data, so the caller
// can decide whether the meta row even needs to render.
const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
const tLang = () => (window.i18n ? window.i18n.lang() : 'en');

// Map locale codes to BCP 47 tags so Intl.NumberFormat picks the right
// thousands-separator / decimal-mark for the currency. Most codes are
// already valid (en, fr, ja, ko, etc.); only pt-BR and zh-CN need touchups
// and even those round-trip fine — kept explicit here for clarity.
function bcp47(code) { return code === 'zh-CN' ? 'zh-Hans-CN' : code; }

function localizedLimitLabel(limit) {
  if (!limit) return '';
  const key = `limit.${limit.id}`;
  const translated = t(key);
  // t() returns the key itself when neither the active locale nor the
  // English fallback has the entry. Detect that and fall back to whatever
  // label the server / normalizer assigned for unknown limit ids.
  return translated && translated !== key ? translated : (limit.label || limit.id || '');
}

function fmtMoney(limit) {
  if (limit.usedCredits == null || limit.monthlyLimit == null) return '';
  // Default to USD if the API didn't tag a currency — most accounts are USD
  // anyway and Intl.NumberFormat throws on an unknown code, which would crash
  // the renderer mid-frame.
  const code = (typeof limit.currency === 'string' && limit.currency) ? limit.currency : 'USD';
  try {
    // Show two decimals — Anthropic's own UI does, and rounding a $13.86 spend
    // to "$14" would conflict with the percentage shown next to the bar.
    const nf = new Intl.NumberFormat(bcp47(tLang()), { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return t('money.used', { used: nf.format(limit.usedCredits), limit: nf.format(limit.monthlyLimit) });
  } catch {
    // Unknown currency code: fall back to a plain-number representation so we
    // still surface the numbers instead of dropping them.
    return t('money.usedPlain', { used: limit.usedCredits.toFixed(2), limit: limit.monthlyLimit.toFixed(2), code });
  }
}

function fmtCountdown(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return t('time.resetting');
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t('time.resets.days', { d, h });
  if (h > 0) return t('time.resets.hours', { h, m });
  return t('time.resets.minutes', { m });
}

function fmtAge(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return t('time.justNow');
  if (sec < 60) return t('time.secondsAgo', { sec });
  const m = Math.floor(sec / 60);
  if (m < 60) return t('time.minutesAgo', { m });
  const h = Math.floor(m / 60);
  return t('time.hoursAgo', { h });
}

function render(payload) {
  const { data, stale, error } = payload;
  lastData = data;
  lastError = error || null;

  // Track when each soft state began so the badge only surfaces after the
  // condition has persisted past its threshold. Clearing on recovery means a
  // brief blip never even reaches the user's eyes.
  if (stale) { if (staleSince == null) staleSince = Date.now(); }
  else { staleSince = null; }
  if (error && error.code === 'RATE_LIMITED') {
    if (throttledSince == null) throttledSince = Date.now();
  } else {
    throttledSince = null;
  }

  if (!data || !data.limits) {
    limitsEl.innerHTML = renderEmptyState(error);
    statusDot.className = `dot ${error ? 'stale' : ''}`;
    lastUpdatedEl.textContent = '';
    pillPct.textContent = '—';
    pillLabel.textContent = '';
    pillDot.className = `pill-dot ${error ? 'stale' : ''}`;
    root.dataset.mascotMood = 'ok';
    staleBadge.hidden = true;
    const eb = errorBadgeFor(error);
    errorBadge.hidden = eb.hidden;
    if (!eb.hidden) {
      errorBadge.textContent = eb.label;
      errorBadge.title = eb.title;
      errorBadge.classList.toggle('error', eb.kind === 'error');
      errorBadge.classList.toggle('warn', eb.kind === 'warn');
      errorBadge.classList.toggle('soft', eb.kind === 'soft');
    }
    renderGraph();
    return;
  }

  const cfg = currentCfg;
  let worstSeverity = 'ok';

  limitsEl.innerHTML = '';
  for (const limit of data.limits) {
    const pct = limit.utilization;
    const sev = severity(pct, cfg);
    if (sev === 'critical') worstSeverity = 'critical';
    else if (sev === 'warn' && worstSeverity !== 'critical') worstSeverity = 'warn';

    const row = document.createElement('div');
    row.className = 'limit';
    // limit-meta is now a single row that combines whichever facts we have for
    // this limit: dollar usage on the left (credit pools only), reset countdown
    // on the right (timed limits). Either or both can be present; if neither
    // is there we omit the row entirely.
    const moneyText = fmtMoney(limit);
    const countdownText = (cfg.showResetCountdown && limit.resetsAt) ? fmtCountdown(limit.resetsAt) : '';
    const showMeta = moneyText || countdownText;
    row.innerHTML = `
      <div class="limit-head">
        <span class="limit-label">${escapeHtml(localizedLimitLabel(limit))}</span>
        <span class="limit-pct">${pct.toFixed(0)}%</span>
      </div>
      <div class="bar">
        <div class="bar-fill ${sev === 'ok' ? '' : sev}" style="width:${pct}%"></div>
        ${cfg.showPaceMarker ? renderPace(limit, pct) : ''}
      </div>
      ${showMeta ? `<div class="limit-meta"><span>${escapeHtml(moneyText)}</span><span>${escapeHtml(countdownText)}</span></div>` : ''}
    `;
    limitsEl.appendChild(row);
  }

  statusDot.className = `dot ${stale ? 'stale' : worstSeverity}`;
  lastUpdatedEl.textContent = t('widget.lastUpdated', { age: fmtAge(data.fetchedAt) });
  renderPill(data, stale, worstSeverity);

  // Claw'd's mood: throttled trumps everything (he naps), otherwise his
  // walking speed mirrors the worst limit's severity tier.
  const mascotMood = (error && error.code === 'RATE_LIMITED' && throttledSince
                       && (Date.now() - throttledSince) >= SOFT_THROTTLE_MS)
    ? 'paused'
    : worstSeverity; // 'ok' | 'warn' | 'critical'
  root.dataset.mascotMood = mascotMood;

  const staleLong = staleSince != null && (Date.now() - staleSince) >= SOFT_STALE_MS;
  staleBadge.hidden = !stale || !cfg.showStaleIndicator || !staleLong;

  const eb = errorBadgeFor(error);
  errorBadge.hidden = eb.hidden;
  if (!eb.hidden) {
    errorBadge.textContent = eb.label;
    errorBadge.title = eb.title;
    errorBadge.classList.toggle('error', eb.kind === 'error');
    errorBadge.classList.toggle('warn', eb.kind === 'warn');
    errorBadge.classList.toggle('soft', eb.kind === 'soft');
  }

  renderGraph();
}

// Renders the body when there's no usage data yet. Distinguishes "no Claude
// Code login on this machine" (onboarding) from "first poll hasn't landed yet"
// from "something failed" — so a new user sees what to do instead of a vague
// spinner.
function renderEmptyState(error) {
  if (error && error.code === 'NO_CREDS') {
    return `
      <div class="empty-state">
        <div class="empty-title">${escapeHtml(t('empty.noCreds.title'))}</div>
        <div class="empty-body">${t('empty.noCreds.body')}</div>
      </div>
    `;
  }
  if (error && error.code === 'AUTH_EXPIRED') {
    return `
      <div class="empty-state">
        <div class="empty-title">${escapeHtml(t('empty.authExpired.title'))}</div>
        <div class="empty-body">${t('empty.authExpired.body')}</div>
      </div>
    `;
  }
  if (error) {
    return `
      <div class="empty-state">
        <div class="empty-title">${escapeHtml(t('empty.generic.title'))}</div>
        <div class="empty-body">${escapeHtml(error.message || t('empty.generic.fallback'))}</div>
      </div>
    `;
  }
  return `<div class="limit-label" style="opacity:0.7">${escapeHtml(t('empty.firstFetch'))}</div>`;
}

// The error-badge label needs to tell the user what's actually going on.
// "OFFLINE" for a 429 made people think the widget was broken. Each error
// class gets its own label + tooltip; rate-limit is warn-colored, not red,
// because it isn't an error — it's "please wait, the API throttled us."
function errorBadgeFor(error) {
  if (!error) return { hidden: true };
  if (error.code === 'NO_CREDS') {
    return { hidden: false, label: t('badge.signIn'), kind: 'warn', title: t('badge.signIn.tooltip') };
  }
  if (error.code === 'AUTH_EXPIRED') {
    return { hidden: false, label: t('badge.auth'), kind: 'error', title: t('badge.auth.tooltip') };
  }
  if (error.code === 'RATE_LIMITED') {
    // Stay silent for the first couple of minutes — most rate-limit windows
    // clear within ~60s and surfacing "throttled" would just panic the user.
    const throttledLong = throttledSince != null && (Date.now() - throttledSince) >= SOFT_THROTTLE_MS;
    if (!throttledLong) return { hidden: true };
    return { hidden: false, label: t('badge.paused'), kind: 'soft', title: t('badge.paused.tooltip') };
  }
  if (error.code === 'HTTP_ERROR') {
    return { hidden: false, label: t('badge.server'), kind: 'error', title: error.message || t('badge.server.tooltip') };
  }
  return { hidden: false, label: t('badge.offline'), kind: 'error', title: error.message || t('badge.offline.tooltip') };
}

// Pill mode shows only the worst-utilized limit at a glance. The label is
// kept tight ("week", "5h", etc) so a non-technical user can read it without
// thinking — the colored dot already encodes severity.
function renderPill(data, stale, worstSeverity) {
  if (!data || !data.limits || data.limits.length === 0) {
    pillPct.textContent = '—';
    pillLabel.textContent = '';
    pillDot.className = `pill-dot ${stale ? 'stale' : ''}`;
    return;
  }
  const worst = data.limits.reduce((a, b) => (a.utilization > b.utilization ? a : b));
  pillPct.textContent = `${Math.round(worst.utilization)}%`;
  pillLabel.textContent = shortLabel(worst);
  // The pill label is text-overflow:ellipsis on narrow pills. Surface the full
  // label as a tooltip so users can confirm which limit they're seeing without
  // expanding the widget.
  pillLabel.title = worst.label || '';
  pillDot.className = `pill-dot ${stale ? 'stale' : worstSeverity}`;
}

function shortLabel(limit) {
  const id = limit.id || '';
  if (id.startsWith('seven_day')) return t('pill.label.week');
  if (id === 'five_hour') return t('pill.label.5h');
  if (id === 'extra')      return t('pill.label.extra');
  // Fallback: first word of the localized label.
  return (localizedLimitLabel(limit) || '').split(/[\s·-]/)[0].toLowerCase();
}

function renderPace(limit, pct) {
  const frac = paceFraction(limit);
  if (frac == null) return '';
  const idealPct = frac * 100;
  const over = pct > idealPct + 5;
  return `<div class="pace ${over ? 'over' : ''}" style="left:${idealPct}%"></div>`;
}

function renderGraph() {
  const cfg = currentCfg;
  if (!cfg?.showHistoryGraph) { graphWrap.hidden = true; return; }
  graphWrap.hidden = false;

  const limitId = cfg.historyLimitId || 'seven_day';
  const limit = lastData?.limits?.find((l) => l.id === limitId);
  graphTitle.textContent = limit
    ? t('graph.title.withLabel', { label: localizedLimitLabel(limit) })
    : t('graph.title.default');
  graphSub.textContent = limit ? t('graph.sub', { pct: limit.utilization.toFixed(0) }) : '';

  // Filter history samples to those with this limit
  const points = (history || [])
    .filter((s) => typeof s[limitId] === 'number')
    .map((s) => ({ t: s.t, v: s[limitId] }));

  if (points.length < 2) {
    graphSvg.innerHTML = '';
    graphEmpty.hidden = false;
    return;
  }
  graphEmpty.hidden = true;

  const W = 260, H = 60, PAD = 4;
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, Date.now());
  const span = Math.max(1, t1 - t0);
  const x = (t) => PAD + ((t - t0) / span) * (W - PAD * 2);

  // Auto-scale Y so low-utilization series still read as a real line instead
  // of hugging the floor. Floor the scale at 25 so a flat-zero chart keeps
  // some headroom and gridlines remain meaningful.
  const peak = points.reduce((m, p) => Math.max(m, p.v), 0);
  const yMax = Math.min(100, Math.max(25, peak * 1.2));
  const y = (v) => PAD + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * (H - PAD * 2);

  let d = `M ${x(points[0].t)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${x(points[i].t)} ${y(points[i].v)}`;
  const areaD = `${d} L ${x(points[points.length - 1].t)} ${H - PAD} L ${x(points[0].t)} ${H - PAD} Z`;

  // Gridlines at 1/4, 1/2, 3/4 of the visible scale (not fixed 25/50/75).
  const gridY = [0.25, 0.5, 0.75].map((f) => {
    const yi = PAD + (1 - f) * (H - PAD * 2);
    return `<line class="grid" x1="${PAD}" y1="${yi}" x2="${W - PAD}" y2="${yi}" />`;
  }).join('');

  graphSvg.innerHTML = `${gridY}<path class="area" d="${areaD}" /><path class="line" d="${d}" />`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Shown only when the update checker has reported a newer release. Clicking
// opens the GitHub release page in the user's default browser — we don't
// auto-download because the portable EXE intentionally doesn't self-rewrite.
function renderUpdate(info) {
  if (!updateLink) return;
  if (!info || !info.available) { updateLink.hidden = true; updateLink.removeAttribute('href'); return; }
  updateLink.hidden = false;
  updateLink.textContent = t('update.available', { version: info.latestVersion });
  updateLink.title = t('update.tooltip', { version: info.latestVersion });
  updateLink.dataset.url = info.releaseUrl || '';
}

async function init() {
  // Fetch translations BEFORE the first render so the very first paint is in
  // the user's language. Without this, the widget would flash English content
  // and then re-render once i18n caught up.
  await window.i18n.init();
  // Re-render the dynamic body whenever the language changes — the static
  // (data-i18n) elements are handled by i18n.applyDom() automatically; this
  // covers the JS-rendered rows (limits, footer, graph head, etc.).
  window.i18n.onChange(() => {
    if (lastData) render({ data: lastData, stale: !!lastError, error: lastError });
  });

  const cfg = await window.api.getConfig();
  applyTheme(cfg);

  const { data, error, history: hist } = await window.api.getLastUsage();
  history = hist || [];
  if (data) render({ data, stale: false, error });
  else if (error) render({ data: null, stale: true, error });

  window.api.onUsage(({ data, stale, history: hist }) => {
    if (hist) history = hist;
    render({ data, stale, error: null });
  });
  window.api.onError(({ error, lastData }) => render({ data: lastData, stale: true, error }));
  window.api.onConfig((newCfg) => {
    applyTheme(newCfg);
    if (lastData) render({ data: lastData, stale: false, error: null });
  });

  // Show the update badge if main already has a result (cached from a check
  // earlier in this session) and on every fresh check after that.
  const cached = await window.api.getUpdate?.();
  renderUpdate(cached);
  window.api.onUpdate?.(renderUpdate);
  updateLink?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = updateLink.dataset.url;
    if (url) window.api.openExternal?.(url);
  });

  // Claw'd: click to hop (or wake him up grumpy if paused), wave on reset.
  const mascotEl = $('mascot');
  const mascotMsgEl = $('mascotMsg');
  // Grumpy lines come from the locale as numbered keys (mascot.grumpy.0..N).
  // Each locale can ship a different count if some quips don't translate well
  // — we discover the length at runtime instead of hardcoding it.
  function grumpyLines() {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const key = `mascot.grumpy.${i}`;
      const value = t(key);
      if (value === key) break; // out of entries for this locale
      out.push(value);
    }
    return out.length ? out : ["Hmph."]; // last-resort fallback so the bubble isn't empty
  }
  let grumpyTimer = null;
  function wakeGrumpy() {
    if (!mascotEl) return;
    if (grumpyTimer) clearTimeout(grumpyTimer);
    if (mascotMsgEl) {
      const lines = grumpyLines();
      mascotMsgEl.textContent = lines[Math.floor(Math.random() * lines.length)];
      mascotMsgEl.hidden = false;
    }
    mascotEl.classList.add('grumpy');
    grumpyTimer = setTimeout(() => {
      mascotEl.classList.remove('grumpy');
      if (mascotMsgEl) mascotMsgEl.hidden = true;
      grumpyTimer = null;
    }, 2000);
  }
  if (mascotEl) {
    mascotEl.addEventListener('click', () => {
      // Asleep: don't hop. Wake him up grumpy with a random complaint.
      if (root.dataset.mascotMood === 'paused') {
        wakeGrumpy();
        return;
      }
      mascotEl.classList.remove('hopping');
      void mascotEl.offsetWidth;
      mascotEl.classList.add('hopping');
      setTimeout(() => mascotEl.classList.remove('hopping'), 500);
    });
  }
  window.api.onReset(() => {
    if (!mascotEl) return;
    mascotEl.classList.remove('waving');
    void mascotEl.offsetWidth;
    mascotEl.classList.add('waving');
    setTimeout(() => mascotEl.classList.remove('waving'), 1700);
  });

  $('refreshBtn').addEventListener('click', async () => {
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    try {
      const result = await window.api.refresh();
      // The poller debounces manual refresh to 10s. Without surfacing this,
      // the spinner runs for a moment and the user wonders why the timestamp
      // didn't change. A quick title-hint + brief shake gives them the signal
      // that the click was acknowledged but skipped.
      if (result && result.debounced) {
        const waitSec = Math.max(1, Math.ceil(result.waitMs / 1000));
        btn.title = t('refresh.debounced', { sec: waitSec });
        btn.classList.add('debounced');
        setTimeout(() => {
          btn.classList.remove('debounced');
          btn.title = t('widget.refresh');
        }, 1200);
      }
    } catch (e) {
      // Without this catch, an IPC rejection (rare but possible if main is
      // restarting) would leave the spinner running forever — a silently
      // broken UI is worse than a logged error.
      console.error('Manual refresh failed:', e);
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 500);
    }
  });
  $('settingsBtn').addEventListener('click', () => window.api.openSettings());
  // Header X hides the widget to the tray instead of quitting — the tooltip
  // already says "Hide", and most users who click X expect to dismiss the
  // window, not lose the tray icon and have to relaunch from Start menu.
  $('closeBtn').addEventListener('click', () => window.api.hideWidget());

  $('minimizeBtn').addEventListener('click', () => {
    const keep = currentCfg.layout === 'minimal' ? currentCfg.lastExpandedLayout : currentCfg.layout;
    window.api.updateConfig({ layout: 'minimal', lastExpandedLayout: keep || 'expanded' });
  });
  $('expandBtn').addEventListener('click', () => {
    window.api.updateConfig({ layout: currentCfg.lastExpandedLayout || 'expanded' });
  });

  setInterval(() => {
    // Preserve the last known error so the soft "syncing"/"paused" gates
    // continue to count up instead of resetting every 30s.
    if (lastData) render({ data: lastData, stale: !!lastError || (staleSince != null), error: lastError });
  }, 30_000);
}

init();
