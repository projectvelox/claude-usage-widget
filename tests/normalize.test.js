const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../src/usage');

// Synthetic fixture modeled on the live `/api/oauth/usage` response shape.
// Field set and null placeholders mirror what Anthropic actually returns;
// the numbers are illustrative and intentionally easy to spot in failures.
const FIXTURE_PAYLOAD = {
  five_hour: { utilization: 50.0, resets_at: '2026-01-01T05:00:00.000000+00:00' },
  seven_day: { utilization: 25.0, resets_at: '2026-01-08T00:00:00.000000+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12.0, resets_at: '2026-01-08T00:00:00.000000+00:00' },
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  cinder_cove: null,
  extra_usage: {
    is_enabled: true,
    // Anthropic returns these in *cents* — 10000 means "$100 cap", 1386 means
    // "$13.86 spent" — and normalize() converts to whole-currency units. The
    // fixture deliberately keeps the cents shape so the test catches anyone
    // who regresses the conversion.
    monthly_limit: 10000,
    used_credits: 1386,
    utilization: 13.86,
    currency: 'USD',
    disabled_reason: null,
  },
};

test('normalize extracts only the active limits, skipping null placeholders', () => {
  const result = normalize(FIXTURE_PAYLOAD, { subscriptionType: 'pro', rateLimitTier: 'default' });
  const ids = result.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['extra_usage', 'five_hour', 'seven_day', 'seven_day_sonnet']);
});

test('normalize labels common limits in friendly form', () => {
  const result = normalize(FIXTURE_PAYLOAD, {});
  const map = Object.fromEntries(result.limits.map((l) => [l.id, l.label]));
  assert.equal(map.five_hour, 'Current session');
  assert.equal(map.seven_day, 'Weekly · all models');
  assert.equal(map.seven_day_sonnet, 'Weekly · Sonnet');
  assert.equal(map.extra_usage, 'Extra usage');
});

test('normalize clamps utilization to 0..100 and preserves windowMs for known ids', () => {
  const result = normalize(FIXTURE_PAYLOAD, {});
  for (const l of result.limits) {
    assert.ok(l.utilization >= 0 && l.utilization <= 100, `utilization ${l.utilization} out of bounds`);
  }
  const fh = result.limits.find((l) => l.id === 'five_hour');
  const sd = result.limits.find((l) => l.id === 'seven_day');
  assert.equal(fh.windowMs, 5 * 60 * 60 * 1000);
  assert.equal(sd.windowMs, 7 * 24 * 60 * 60 * 1000);
});

test('normalize treats small utilization as a literal percent, not a 0..1 fraction', () => {
  const result = normalize({ seven_day_sonnet: { utilization: 1, resets_at: null } }, {});
  assert.equal(result.limits[0].utilization, 1);

  const frac = normalize({ five_hour: { utilization: 0.42, resets_at: null } }, {});
  assert.equal(frac.limits[0].utilization, 0.42);
});

test('normalize returns empty limits for empty payload, without crashing', () => {
  assert.deepEqual(normalize({}, {}).limits, []);
  assert.deepEqual(normalize(null, {}).limits, []);
});

test('normalize preserves subscription metadata for downstream use', () => {
  const r = normalize(FIXTURE_PAYLOAD, { subscriptionType: 'pro', rateLimitTier: 'default' });
  assert.equal(r.subscriptionType, 'pro');
  assert.equal(r.rateLimitTier, 'default');
});

test('normalize is resilient to a wrapper key (limits/quotas)', () => {
  const wrapped = { limits: { five_hour: { utilization: 50, resets_at: null } } };
  const r = normalize(wrapped, {});
  assert.equal(r.limits.length, 1);
  assert.equal(r.limits[0].utilization, 50);
});

test('normalize collapses the new `limits` array against the old top-level keys', () => {
  // Regression: in mid-2026 Anthropic started returning both the legacy
  // top-level keys (five_hour, seven_day, seven_day_sonnet, extra_usage) and
  // a new normalized `limits` array + `spend` object containing the same
  // data. The widget rendered every row twice — once as "Current session",
  // again as "0", and so on for "Spend" vs "Extra usage". Dedup by
  // (resets_at, rounded utilization) keeps the richer original row and drops
  // the slimmer dup.
  const payload = {
    five_hour: { utilization: 19, resets_at: '2026-06-17T06:09:59.814020+00:00' },
    seven_day: { utilization: 51, resets_at: '2026-06-20T15:59:59.814040+00:00' },
    seven_day_sonnet: { utilization: 6, resets_at: '2026-06-20T15:59:59.814047+00:00' },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 10000,
      used_credits: 2343,
      utilization: 23.43,
      currency: 'USD',
    },
    limits: [
      { kind: 'session', percent: 19, resets_at: '2026-06-17T06:09:59.814020+00:00' },
      { kind: 'weekly_all', percent: 51, resets_at: '2026-06-20T15:59:59.814040+00:00' },
      { kind: 'weekly_scoped', percent: 6, resets_at: '2026-06-20T15:59:59.814047+00:00' },
    ],
    spend: { percent: 23, enabled: true },
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['extra_usage', 'five_hour', 'seven_day', 'seven_day_sonnet']);
  // The legacy row should win and keep its currency fields (the new `spend`
  // shape lacks used_credits / monthly_limit in the form we currently consume).
  const extra = r.limits.find((l) => l.id === 'extra_usage');
  assert.equal(extra.usedCredits, 23.43);
  assert.equal(extra.monthlyLimit, 100);
});

test('normalize falls back to the new `limits` array when legacy keys are absent', () => {
  // Forward-compat: if Anthropic eventually drops the old top-level keys and
  // only returns the array, rows should still be labeled by `kind` rather
  // than the numeric Object.entries index ("0", "1", "2").
  const payload = {
    limits: [
      { kind: 'session', percent: 42, resets_at: '2026-06-17T06:09:59.000000+00:00' },
      { kind: 'weekly_all', percent: 88, resets_at: '2026-06-20T15:59:59.000000+00:00' },
    ],
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['session', 'weekly_all']);
});

test('normalize surfaces scoped weekly limits with an id derived from display_name', () => {
  // Real-world payload for an account that hasn't used Fable yet: the only
  // Fable signal in the response is a weekly_scoped entry in the new limits
  // array carrying `scope.model.display_name`. Before this fix the row got
  // deduped away by `spend` (both at 0% with no resets_at) and, even without
  // the collision, would have rendered as "Weekly Scoped" instead of naming
  // Fable.
  const payload = {
    five_hour: { utilization: 26, resets_at: '2026-07-06T07:50:00.324439+00:00' },
    seven_day: { utilization: 8, resets_at: '2026-07-11T16:00:00.324461+00:00' },
    seven_day_sonnet: null,
    limits: [
      { kind: 'session', percent: 26, resets_at: '2026-07-06T07:50:00.324439+00:00' },
      { kind: 'weekly_all', percent: 8, resets_at: '2026-07-11T16:00:00.324461+00:00' },
      { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    ],
    spend: {
      used: { amount_minor: 0, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      percent: 0,
      enabled: true,
    },
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  // Legacy top-level rows keep their ids; spend aliases to extra_usage;
  // Fable's weekly_scoped entry gets a per-model id + scopeModel field.
  assert.deepEqual(ids, ['extra_usage', 'five_hour', 'seven_day', 'seven_day_fable']);
  const fable = r.limits.find((l) => l.id === 'seven_day_fable');
  assert.equal(fable.scopeModel, 'Fable');
  assert.equal(fable.label, 'Weekly · Fable');
  assert.equal(fable.utilization, 0);
  assert.equal(fable.windowMs, 7 * 24 * 60 * 60 * 1000);
});

test('normalize keeps scoped limits distinct from spend at the same 0% + no-reset fingerprint', () => {
  // Direct regression test for the collision: without the scope dimension in
  // the fingerprint, Fable (0%, no resets_at) hashes identically to spend
  // (0%, no resets_at) and gets dropped.
  const payload = {
    spend: { percent: 0, enabled: true, used: { amount_minor: 0, exponent: 2 }, limit: { amount_minor: 10000, exponent: 2 } },
    limits: [
      { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    ],
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['extra_usage', 'seven_day_fable']);
});

test('normalize slugifies scoped model display names into stable ids', () => {
  const payload = {
    limits: [
      { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Haiku 5' } } },
      { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Opus 4.7 (1M context)' } } },
    ],
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['seven_day_haiku_5', 'seven_day_opus_4_7_1m_context']);
});

test('normalize surfaces spend when extra_usage exists with null utilization', () => {
  // Regression: the API returns both `extra_usage` (utilization: null when
  // the user hasn't touched credits yet — used_credits is set but the
  // percentage isn't) AND `spend` (the new shape carrying the actual
  // numbers). Before this fix v0.2.24's early seen.add() reserved the
  // 'extra_usage' slot when processing the null-utilization legacy row and
  // silently blocked the sibling spend row from being surfaced — the widget
  // showed no Extra usage line at all despite the account having a credit
  // pool.
  const payload = {
    five_hour: { utilization: 12, resets_at: null },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 10000,
      used_credits: 0,
      utilization: null,
      currency: 'USD',
    },
    spend: {
      used: { amount_minor: 0, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      percent: 0,
      enabled: true,
    },
  };
  const r = normalize(payload, {});
  const ids = r.limits.map((l) => l.id).sort();
  assert.deepEqual(ids, ['extra_usage', 'five_hour']);
  const extra = r.limits.find((l) => l.id === 'extra_usage');
  assert.equal(extra.utilization, 0);
  assert.equal(extra.usedCredits, 0);
  assert.equal(extra.monthlyLimit, 100);
  assert.equal(extra.currency, 'USD');
});

test('normalize aliases spend to extra_usage and reads its nested dollar shape', () => {
  // The mid-2026 API sometimes returns the new `spend` object without the
  // legacy `extra_usage` field (accounts whose plan uses only the new
  // shape). Before this fix the widget rendered "Spend 0%" with no dollar
  // context; now it aliases to extra_usage and pulls used/limit from the
  // nested amount_minor + exponent form.
  const payload = {
    five_hour: { utilization: 12, resets_at: null },
    spend: {
      used: { amount_minor: 2343, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      percent: 23,
      severity: 'normal',
      enabled: true,
    },
  };
  const r = normalize(payload, {});
  const extra = r.limits.find((l) => l.id === 'extra_usage');
  assert.ok(extra, 'spend should be aliased to extra_usage');
  assert.equal(extra.label, 'Extra usage');
  assert.equal(extra.utilization, 23);
  assert.equal(extra.usedCredits, 23.43);
  assert.equal(extra.monthlyLimit, 100);
  assert.equal(extra.currency, 'USD');
});

test('normalize skips a `spend` entry that is explicitly disabled', () => {
  // The new `spend` shape uses `enabled: false` (not `is_enabled`) when the
  // account hasn't opted into a credit pool. Treat it the same way.
  const r = normalize({
    five_hour: { utilization: 12, resets_at: null },
    spend: { percent: 0, enabled: false },
  }, {});
  assert.deepEqual(r.limits.map((l) => l.id), ['five_hour']);
});

test('normalize converts credit-pool cents to whole-currency units', () => {
  // Regression: pre-v0.2.17 the widget displayed "$1,386 of $10,000" for the
  // canonical "$13.86 of $100" account — a 100× overstatement that hid the
  // real spend. Pin the conversion so this can't slip past tests again.
  const r = normalize(FIXTURE_PAYLOAD, {});
  const extra = r.limits.find((l) => l.id === 'extra_usage');
  assert.equal(extra.usedCredits, 13.86);
  assert.equal(extra.monthlyLimit, 100);
  assert.equal(extra.currency, 'USD');
});

test('normalize skips limits where is_enabled is explicitly false', () => {
  // Mirrors a real account that has extra_usage configured but turned off —
  // the bar would otherwise render at 0% forever, which is noise.
  const r = normalize({
    extra_usage: { is_enabled: false, utilization: 0, monthly_limit: 10000, used_credits: 0 },
    five_hour: { utilization: 12, resets_at: null },
  }, {});
  assert.deepEqual(r.limits.map((l) => l.id), ['five_hour']);
});

test('normalize keeps the extra_usage row when is_enabled is true', () => {
  const r = normalize(FIXTURE_PAYLOAD, {});
  assert.ok(r.limits.find((l) => l.id === 'extra_usage'));
});

test('normalize does not attach credit-pool fields to limits that lack them', () => {
  // five_hour and seven_day don't carry monthly_limit / used_credits, so the
  // normalized objects should NOT have those keys defined — otherwise the
  // renderer's fmtMoney check (usedCredits == null) would mistake "undefined
  // but present" as "show empty dollar string".
  const r = normalize(FIXTURE_PAYLOAD, {});
  const fh = r.limits.find((l) => l.id === 'five_hour');
  assert.equal('usedCredits' in fh, false);
  assert.equal('monthlyLimit' in fh, false);
  assert.equal('currency' in fh, false);
});
