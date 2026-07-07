const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

// Known window lengths per limit id. Pace marker uses these to compute the
// actual start of the current window (resets_at minus window_length). Previously
// we inferred from time-to-reset which drifted near the moment of reset.
const WINDOW_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
  seven_day_opus: 7 * 24 * 60 * 60 * 1000,
  seven_day_cowork: 7 * 24 * 60 * 60 * 1000,
  seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
};

// Read the credentials JSON blob from the macOS login Keychain. On darwin,
// Claude Code stores its OAuth token there instead of the plaintext
// ~/.claude/.credentials.json file (which is the Linux/Windows/fallback
// location), so the Keychain is the real source of truth on macOS. Returns
// the raw JSON string, or null when the platform isn't macOS or the item
// doesn't exist. Isolated behind module.exports so the test suite can stub
// it without spawning the `security` binary.
function readKeychainCreds() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8' },
    );
    return out.trim() || null;
  } catch (e) {
    // Non-zero exit (item not found) or `security` unavailable — treat as
    // "no keychain credential" and let the caller fall through to NO_CREDS.
    return null;
  }
}

function readToken() {
  let raw;
  try {
    raw = fs.readFileSync(CREDS_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // On macOS the plaintext file usually never exists — Claude Code keeps
      // the token in the login Keychain — so a missing file is expected there.
      // Fall back to the Keychain before concluding the user hasn't logged in.
      raw = module.exports.readKeychainCreds();
      if (!raw) {
        // Distinct from AUTH_EXPIRED: neither the file nor the Keychain has a
        // credential, so the user has not signed in via Claude Code yet. The
        // UI shows an onboarding message instead of the generic "offline" badge.
        const err = new Error('No Claude Code login found. Run `claude` in a terminal to sign in.');
        err.code = 'NO_CREDS';
        throw err;
      }
    } else {
      throw e;
    }
  }
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    const err = new Error('claudeAiOauth.accessToken missing from ~/.claude/.credentials.json');
    err.code = 'NO_CREDS';
    throw err;
  }
  return {
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  };
}

async function fetchUsage({ retryOnAuth = true } = {}) {
  const { token, subscriptionType, rateLimitTier } = readToken();
  const res = await fetch(USAGE_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': BETA_HEADER,
      'User-Agent': 'claude-usage-widget/0.1',
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
    const err = new Error('Rate limited');
    err.code = 'RATE_LIMITED';
    err.retryAfter = retryAfter;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    // Token may have been refreshed by another Claude Code session between
    // our last readToken() and this fetch. Re-read once and retry immediately.
    if (retryOnAuth) {
      const fresh = readToken();
      if (fresh.token !== token) return fetchUsage({ retryOnAuth: false });
    }
    const err = new Error('Auth expired — run `claude` in a terminal to refresh.');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }
  if (!res.ok) {
    // Drain the body to free the socket, but do NOT include it in the error
    // message — Anthropic occasionally echoes the bearer token in error
    // bodies ("invalid token: sk-…") and we broadcast errors to the renderer
    // / log them locally. Status + statusText is enough to drive backoff.
    await res.text().catch(() => '');
    const err = new Error(`Usage fetch failed: HTTP ${res.status} ${res.statusText || ''}`.trim());
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    // A 2xx response with a malformed body (proxy interference, partial
    // download, surprise HTML error page) used to crash the poller's tick.
    // Surface as a normal HTTP_ERROR so the existing backoff applies.
    const err = new Error('Server returned a non-JSON response.');
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return normalize(data, { subscriptionType, rateLimitTier });
}

function normalize(raw, meta = {}) {
  const limits = [];
  const seen = new Set();
  const seenFingerprint = new Set();
  const candidates = [];

  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      // Skip arrays in the top-level scan — they're handled by the wrapper
      // loop below so their items get unwrapped instead of treated as one row.
      if (Array.isArray(value)) continue;
      if (value && typeof value === 'object' && ('utilization' in value || 'percent' in value || 'usage' in value)) {
        candidates.push([key, value]);
      }
    }
    for (const wrapKey of ['limits', 'quotas', 'rate_limits']) {
      const wrap = raw[wrapKey];
      if (!wrap || typeof wrap !== 'object') continue;
      if (Array.isArray(wrap)) {
        // New API shape (mid-2026): `limits` is an array of normalized records
        // with kind/percent/resets_at. Object.entries would yield "0","1","2"
        // as keys, producing nameless rows. Use each item's `kind` (or id/name)
        // so labels stay meaningful if Anthropic ever removes the old top-level
        // keys. Duplicates against those top-level keys are dropped by the
        // content fingerprint below.
        for (const item of wrap) {
          if (!item || typeof item !== 'object') continue;
          const key = (typeof item.kind === 'string' && item.kind)
            || (typeof item.id === 'string' && item.id)
            || (typeof item.name === 'string' && item.name);
          if (!key) continue;
          candidates.push([key, item]);
        }
      } else {
        for (const [key, value] of Object.entries(wrap)) {
          if (value && typeof value === 'object') candidates.push([key, value]);
        }
      }
    }
  }

  for (const [key, value] of candidates) {
    // Compute the aliased id up front so two different scoped weekly limits
    // (e.g. Fable and Haiku 5, both coming through as `weekly_scoped`) don't
    // collide in the key-based seen set below.
    //
    // Key aliasing:
    //   * `spend` (mid-2026 new credit-pool shape) → `extra_usage` so
    //     downstream label lookups, i18n keys, and config bindings stay on
    //     the same identifier as the legacy field.
    //   * `weekly_scoped` (from the new `limits` array, one entry per
    //     model-specific weekly limit) → `seven_day_<slug>` derived from
    //     `scope.model.display_name` — e.g. Fable → `seven_day_fable`,
    //     "Haiku 5" → `seven_day_haiku_5`. Any scoped model surfaces with a
    //     unique id and a `scopeModel` field the renderer uses to build the
    //     localized "Weekly · <model>" label.
    const scopeDisplayName = (value.scope && value.scope.model && typeof value.scope.model.display_name === 'string')
      ? value.scope.model.display_name : '';
    let canonicalKey = key;
    if (key === 'spend') canonicalKey = 'extra_usage';
    if (key === 'weekly_scoped' && scopeDisplayName) {
      const slug = scopeDisplayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (slug) canonicalKey = `seven_day_${slug}`;
    }
    const utilization = pickNumber(value.utilization, value.percent, value.percentage, value.usage);
    if (utilization == null) continue;
    // Skip limits the API explicitly marks disabled (e.g. extra_usage when the
    // user hasn't opted in). Showing "0%" for something that can never grow
    // would just be confusing noise.
    if (value.is_enabled === false) continue;
    if (value.enabled === false) continue;
    // Only reserve the seen slot AFTER the row has cleared every validity
    // check. Otherwise a null-utilization `extra_usage` row (which is what
    // the API returns when the user hasn't touched credits yet) would claim
    // 'extra_usage' before being skipped, and the sibling `spend` row that
    // aliases to the same canonical key would then get blocked — even
    // though `spend` is the only row that actually carries the data.
    if (seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);
    // Content-based dedup: Anthropic now returns the same usage data under
    // multiple shapes simultaneously (e.g. top-level `extra_usage` + new
    // `spend` object, top-level `five_hour` + an entry in the new `limits`
    // array). Fingerprint by (resets_at, rounded utilization, scope model)
    // so the second occurrence is dropped. Scope is the newer dimension:
    // without it, a scoped weekly limit at 0% (e.g. "Fable" for an account
    // that hasn't used Fable yet) would fingerprint identically to `spend`
    // at 0% and get deduped away. Candidates are pushed top-level-first,
    // so the richer original row wins and the slimmer dup is suppressed.
    const resetsAtFp = value.resets_at || value.resetsAt || value.reset_at || '';
    const fp = `${resetsAtFp}|${Math.round(utilization)}|${scopeDisplayName}`;
    if (seenFingerprint.has(fp)) continue;
    seenFingerprint.add(fp);
    const limit = {
      id: canonicalKey,
      label: scopeDisplayName ? `Weekly · ${scopeDisplayName}` : prettyLabel(canonicalKey),
      utilization: clamp(utilization, 0, 100),
      resetsAt: value.resets_at || value.resetsAt || value.reset_at || null,
      windowMs: WINDOW_MS[canonicalKey] || (key === 'weekly_scoped' ? 7 * 24 * 60 * 60 * 1000 : null),
    };
    if (scopeDisplayName) limit.scopeModel = scopeDisplayName;
    // Credit-pool limits expose dollar amounts alongside the percentage.
    // Two shapes coexist right now:
    //   Legacy `extra_usage`: flat `used_credits` / `monthly_limit` in
    //   cents (10000 = "$100.00"). Currency in `value.currency`.
    //   New `spend`: nested `used.amount_minor` / `limit.amount_minor`
    //   with an explicit `exponent` (usually 2). Currency on each side.
    // Read either. Cents division is baked into the exponent path.
    const usedCentsRaw = pickNumber(value.used_credits, value.usedCredits);
    const limitCentsRaw = pickNumber(value.monthly_limit, value.monthlyLimit);
    if (usedCentsRaw != null) limit.usedCredits = usedCentsRaw / 100;
    if (limitCentsRaw != null) limit.monthlyLimit = limitCentsRaw / 100;
    if (typeof value.currency === 'string' && value.currency) limit.currency = value.currency;
    if (value.used && typeof value.used === 'object') {
      const usedMinor = pickNumber(value.used.amount_minor, value.used.amountMinor);
      const exponent = pickNumber(value.used.exponent) ?? 2;
      if (usedMinor != null) limit.usedCredits = usedMinor / Math.pow(10, exponent);
      if (typeof value.used.currency === 'string' && value.used.currency) limit.currency = value.used.currency;
    }
    if (value.limit && typeof value.limit === 'object') {
      const limitMinor = pickNumber(value.limit.amount_minor, value.limit.amountMinor);
      const exponent = pickNumber(value.limit.exponent) ?? 2;
      if (limitMinor != null) limit.monthlyLimit = limitMinor / Math.pow(10, exponent);
      if (typeof value.limit.currency === 'string' && value.limit.currency) limit.currency = value.limit.currency;
    }
    limits.push(limit);
  }

  return {
    fetchedAt: Date.now(),
    limits,
    subscriptionType: meta.subscriptionType || null,
    rateLimitTier: meta.rateLimitTier || null,
  };
}

function pickNumber(...values) {
  for (const v of values) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return null;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function prettyLabel(key) {
  const map = {
    five_hour: 'Current session',
    seven_day: 'Weekly · all models',
    seven_day_sonnet: 'Weekly · Sonnet',
    seven_day_opus: 'Weekly · Opus',
    seven_day_cowork: 'Weekly · Cowork',
    cowork: 'Cowork',
    routines: 'Daily routines',
    extra_usage: 'Extra usage',
  };
  if (map[key]) return map[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { fetchUsage, readToken, readKeychainCreds, normalize, CREDS_PATH, WINDOW_MS };
