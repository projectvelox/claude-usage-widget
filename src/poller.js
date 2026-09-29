const { fetchUsage } = require('./usage');

// Lessons applied:
//   jens-duttke + f-is-h: adaptive interval, short when active, long when idle.
//   jens-duttke: honor Retry-After on 429, exponential backoff on errors, surface stale-data state.
//   f-is-h: 10s debounce on manual refresh, refresh on system wake.
//   jens-duttke: align refresh to the nearest reset boundary so the bar zeroes visibly.
//   jens-duttke: on_reset_command hook — fire a configured shell command when a quota resets.

const INTERVALS = {
  active: 60_000,
  idle: 180_000,
  deepIdle: 600_000,
  locked: 1_800_000,
};

const MANUAL_DEBOUNCE_MS = 10_000;
const RESET_ALIGN_WINDOW_MS = 30_000;
const RATE_LIMIT_BASE_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

class Poller {
  constructor({ onUpdate, onError, onReset, getActivityState }) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onReset = onReset || (() => {});
    this.getActivityState = getActivityState || (() => 'active');
    this.timer = null;
    this.lastFetchAt = 0;
    this.lastManualAt = 0;
    this.consecutiveErrors = 0;
    this.lastData = null;
    this.stale = false;
  }

  start() { this.schedule(500); }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(1_000, delay));
  }

  async manualRefresh() {
    const since = Date.now() - this.lastManualAt;
    if (since < MANUAL_DEBOUNCE_MS) return { debounced: true, waitMs: MANUAL_DEBOUNCE_MS - since };
    this.lastManualAt = Date.now();
    await this.tick();
    return { debounced: false };
  }

  async tick() {
    try {
      const data = await fetchUsage();
      this.detectResets(this.lastData, data);
      this.lastData = data;
      this.lastFetchAt = Date.now();
      this.consecutiveErrors = 0;
      this.stale = false;
      this.onUpdate(data, { stale: false });
      this.schedule(this.nextDelay(data));
    } catch (err) {
      this.consecutiveErrors += 1;
      this.stale = true;
      this.onError(err, { lastData: this.lastData });
      this.schedule(this.errorDelay(err));
    }
  }

  errorDelay(err) {
    const n = this.consecutiveErrors;
    // The usage endpoint answers 429 with `retry-after: 0` (or no header).
    // Trusting that literally re-polled every second, which kept the account
    // throttled indefinitely. Back off exponentially from 60s (up to 30 min)
    // and only honor Retry-After when it asks for a longer wait.
    if (err.code === 'RATE_LIMITED') {
      const backoff = Math.min(RATE_LIMIT_BASE_MS * 2 ** Math.min(n - 1, 5), MAX_BACKOFF_MS);
      const retryAfterMs = Number.isFinite(err.retryAfter) ? err.retryAfter * 1000 : 0;
      return Math.max(backoff, retryAfterMs);
    }
    if (err.code === 'AUTH_EXPIRED') return 5 * 60_000;
    if (err.code === 'NO_CREDS') return 15_000;
    // First failure retries quickly (8s) so a user who just signed in sees
    // the widget pick up almost immediately. Subsequent failures back off
    // exponentially up to 30 min, same ceiling as before.
    if (n === 1) return 8_000;
    return Math.min(15_000 * 2 ** Math.min(n - 1, 7), MAX_BACKOFF_MS);
  }

  detectResets(prev, curr) {
    if (!prev || !Array.isArray(prev.limits) || !curr || !Array.isArray(curr.limits)) return;
    const prevById = new Map(prev.limits.map((l) => [l.id, l]));
    for (const lim of curr.limits) {
      const p = prevById.get(lim.id);
      if (!p) continue;
      // Reset detected if resetsAt advanced OR utilization dropped sharply with a new window.
      const prevReset = p.resetsAt ? new Date(p.resetsAt).getTime() : null;
      const currReset = lim.resetsAt ? new Date(lim.resetsAt).getTime() : null;
      if (prevReset && currReset && currReset > prevReset + 60_000) {
        this.onReset({ id: lim.id, label: lim.label, prevReset: p.resetsAt, currReset: lim.resetsAt, currUtilization: lim.utilization });
      }
    }
  }

  nextDelay(data) {
    const baseTier = this.getActivityState();
    let base = INTERVALS[baseTier] ?? INTERVALS.active;
    const nextReset = nextResetMs(data);
    if (nextReset != null && nextReset > 0 && nextReset < base + RESET_ALIGN_WINDOW_MS) {
      return Math.max(5_000, nextReset + 3_000);
    }
    return base;
  }

  notifyWake() {
    this.lastManualAt = 0;
    this.schedule(500);
  }
}

function nextResetMs(data) {
  if (!data || !Array.isArray(data.limits)) return null;
  const now = Date.now();
  let min = Infinity;
  for (const limit of data.limits) {
    if (!limit.resetsAt) continue;
    const ms = new Date(limit.resetsAt).getTime() - now;
    if (Number.isFinite(ms) && ms > 0 && ms < min) min = ms;
  }
  return Number.isFinite(min) ? min : null;
}

module.exports = { Poller, INTERVALS, nextResetMs };
