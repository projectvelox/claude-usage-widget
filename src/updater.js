// In-app update check. Reads the GitHub Releases list, picks the newest
// published vMAJOR.MINOR.PATCH tag, and counts how many releases the running
// version is behind. Installing is handled separately by src/selfUpdate.js
// when the user accepts the prompt.

const RELEASES_URL = 'https://api.github.com/repos/projectvelox/claude-usage-widget/releases?per_page=100';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const REQUEST_TIMEOUT_MS = 8_000;

async function fetchReleases() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'claude-usage-widget',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 403 means we hit the unauthenticated rate limit (60/h per IP). Not an
      // error worth surfacing — just skip this cycle and try again tomorrow.
      const err = new Error(`GitHub returned ${res.status}`);
      err.code = res.status === 403 ? 'RATE_LIMITED' : 'HTTP_ERROR';
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Returns negative if a < b, 0 if equal, positive if a > b. Pre-release/build
// metadata is dropped on parse — we only ship plain X.Y.Z tags, so this is fine.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Pure summary of a GitHub releases list relative to the running version:
// the newest published release, and how many published releases are newer
// than `current` (drafts, prereleases and non-semver tags are ignored).
function summarizeReleases(releases, current) {
  const published = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && !r.prerelease)
    .map((r) => ({ release: r, version: parseVersion(r.tag_name) }))
    .filter((r) => r.version)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (published.length === 0) return null;
  const behind = published.filter((r) => compareVersions(r.version, current) > 0).length;
  return { latest: published[0], behind };
}

async function checkForUpdate(currentVersion) {
  const current = parseVersion(currentVersion);
  if (!current) return { available: false, reason: 'bad-current-version' };

  const summary = summarizeReleases(await fetchReleases(), current);
  if (!summary) return { available: false, reason: 'no-releases' };

  const { latest, behind } = summary;
  // Build the release URL from the version we just validated instead of
  // trusting `release.html_url`. If the GitHub response were ever tampered
  // with (MITM, mirror compromise), an attacker could phish the user via a
  // spoofed link. The hardcoded host means `shell:openExternal` only ever
  // opens our repo.
  const tag = latest.version.join('.');
  return {
    available: behind > 0,
    behind,
    currentVersion,
    latestVersion: tag,
    releaseUrl: `https://github.com/projectvelox/claude-usage-widget/releases/tag/v${tag}`,
    publishedAt: latest.release.published_at || null,
    checkedAt: Date.now(),
  };
}

module.exports = { checkForUpdate, summarizeReleases, parseVersion, compareVersions, CHECK_INTERVAL_MS };
