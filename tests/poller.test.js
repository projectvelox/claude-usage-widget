const test = require('node:test');
const assert = require('node:assert/strict');
const { Poller, INTERVALS, nextResetMs } = require('../src/poller');

// Helper — construct a Poller without starting it, with stub callbacks we can
// assert against. None of these tests trigger the network or schedule timers.
function makePoller(overrides = {}) {
  const events = { update: [], error: [], reset: [] };
  const poller = new Poller({
    onUpdate: (data, meta) => events.update.push({ data, meta }),
    onError: (err, meta) => events.error.push({ err, meta }),
    onReset: (info) => events.reset.push(info),
    getActivityState: overrides.getActivityState || (() => 'active'),
  });
  return { poller, events };
}

const T0 = new Date('2026-06-10T12:00:00Z').toISOString();
const T1 = new Date('2026-06-10T13:00:00Z').toISOString();
const T2 = new Date('2026-06-10T14:00:00Z').toISOString();

test('detectResets fires onReset when resetsAt advances past 1-minute slop', () => {
  const { poller, events } = makePoller();
  const prev = { limits: [{ id: 'five_hour', label: 'Current session', resetsAt: T0, utilization: 80 }] };
  const curr = { limits: [{ id: 'five_hour', label: 'Current session', resetsAt: T1, utilization: 5 }] };
  poller.detectResets(prev, curr);
  assert.equal(events.reset.length, 1);
  assert.equal(events.reset[0].id, 'five_hour');
  assert.equal(events.reset[0].currUtilization, 5);
});

test('detectResets ignores sub-minute drift in resetsAt (no fire)', () => {
  const { poller, events } = makePoller();
  const a = new Date('2026-06-10T12:00:00Z').toISOString();
  const b = new Date('2026-06-10T12:00:30Z').toISOString();
  poller.detectResets(
    { limits: [{ id: 'five_hour', resetsAt: a }] },
    { limits: [{ id: 'five_hour', resetsAt: b }] },
  );
  assert.equal(events.reset.length, 0);
});

test('detectResets is a no-op when either side is null or missing limits', () => {
  const { poller, events } = makePoller();
  poller.detectResets(null, { limits: [{ id: 'x', resetsAt: T1 }] });
  poller.detectResets({ limits: [{ id: 'x', resetsAt: T0 }] }, null);
  poller.detectResets({}, { limits: [{ id: 'x', resetsAt: T1 }] });
  assert.equal(events.reset.length, 0);
});

test('detectResets only fires for ids that exist in both snapshots', () => {
  const { poller, events } = makePoller();
  // 'extra_usage' is new in curr — must NOT count as a reset on its own.
  const prev = { limits: [{ id: 'five_hour', resetsAt: T0 }] };
  const curr = { limits: [
    { id: 'five_hour', resetsAt: T1 },
    { id: 'extra_usage', resetsAt: T1 },
  ] };
  poller.detectResets(prev, curr);
  assert.equal(events.reset.length, 1);
  assert.equal(events.reset[0].id, 'five_hour');
});

test('nextDelay picks the base interval matching the activity tier', () => {
  for (const tier of ['active', 'idle', 'deepIdle', 'locked']) {
    const { poller } = makePoller({ getActivityState: () => tier });
    // No data → nextResetMs returns null → base interval used as-is.
    assert.equal(poller.nextDelay(null), INTERVALS[tier]);
  }
});

test('nextDelay snaps to reset boundary when one is close enough', () => {
  const { poller } = makePoller({ getActivityState: () => 'active' });
  // A reset 90 seconds away is well inside (active=60s) + (window=30s).
  const data = { limits: [{ resetsAt: new Date(Date.now() + 90_000).toISOString() }] };
  const delay = poller.nextDelay(data);
  // Should be (resetMs + 3s padding), clamped to >= 5s.
  assert.ok(delay >= 5_000 && delay <= 95_000, `delay out of expected band: ${delay}`);
});

test('nextDelay falls back to base interval when no reset is near', () => {
  const { poller } = makePoller({ getActivityState: () => 'active' });
  // Reset is 24h away — well beyond the alignment window.
  const data = { limits: [{ resetsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }] };
  assert.equal(poller.nextDelay(data), INTERVALS.active);
});

test('nextDelay falls back to active interval for unknown tiers', () => {
  const { poller } = makePoller({ getActivityState: () => 'bogus-tier' });
  assert.equal(poller.nextDelay(null), INTERVALS.active);
});

test('nextResetMs returns null when data is missing or has no resets', () => {
  assert.equal(nextResetMs(null), null);
  assert.equal(nextResetMs({}), null);
  assert.equal(nextResetMs({ limits: [] }), null);
  assert.equal(nextResetMs({ limits: [{ resetsAt: null }] }), null);
});

test('nextResetMs returns the soonest positive remaining duration', () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  const later = new Date(Date.now() + 600_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString(); // expired — must be ignored
  const ms = nextResetMs({ limits: [{ resetsAt: later }, { resetsAt: past }, { resetsAt: soon }] });
  assert.ok(ms > 0 && ms <= 60_000, `expected ~60_000, got ${ms}`);
});

test('manualRefresh is debounced within the 10s window', async () => {
  const { poller } = makePoller();
  // Stub out tick so we don't need a real network call.
  let ticks = 0;
  poller.tick = async () => { ticks += 1; };
  await poller.manualRefresh();
  const second = await poller.manualRefresh();
  assert.equal(ticks, 1);
  assert.equal(second.debounced, true);
  assert.ok(second.waitMs > 0 && second.waitMs <= 10_000, `waitMs out of range: ${second.waitMs}`);
});

test('errorDelay never hot-loops on 429 with retry-after 0 or missing', () => {
  const { poller } = makePoller();
  const rl = (retryAfter) => Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', retryAfter });
  poller.consecutiveErrors = 1;
  assert.equal(poller.errorDelay(rl(0)), 60_000);
  assert.equal(poller.errorDelay(rl(NaN)), 60_000);
  assert.equal(poller.errorDelay(rl(undefined)), 60_000);
});

test('errorDelay backs off exponentially on repeated 429s, capped at 30 min', () => {
  const { poller } = makePoller();
  const err = Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', retryAfter: 0 });
  const delays = [1, 2, 3, 4, 5, 6, 7, 20].map((n) => { poller.consecutiveErrors = n; return poller.errorDelay(err); });
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
});

test('errorDelay honors a Retry-After longer than the backoff', () => {
  const { poller } = makePoller();
  poller.consecutiveErrors = 1;
  const err = Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', retryAfter: 300 });
  assert.equal(poller.errorDelay(err), 300_000);
});

test('errorDelay keeps the quick first retry for generic errors', () => {
  const { poller } = makePoller();
  poller.consecutiveErrors = 1;
  assert.equal(poller.errorDelay(new Error('boom')), 8_000);
  poller.consecutiveErrors = 2;
  assert.equal(poller.errorDelay(new Error('boom')), 30_000);
});
