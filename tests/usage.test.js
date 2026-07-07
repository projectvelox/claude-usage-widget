const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const usage = require('../src/usage');
const { fetchUsage } = usage;

// Lightweight stub for a Response-like object — avoids importing the global
// Response constructor (which has quirky body handling) and lets us control
// header lookup precisely.
function makeResponse({ status = 200, statusText = '', headers = {}, json = null, text = '' }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k) => lower[k.toLowerCase()] ?? null },
    json: async () => {
      if (json instanceof Error) throw json;
      return json;
    },
    text: async () => text,
  };
}

// Replaces global fetch for the duration of one test. The Node test runner
// auto-restores t.mock when the test finishes.
function stubFetch(t, response) {
  t.mock.method(globalThis, 'fetch', async () => response);
}

// Replaces fs.readFileSync to simulate the credentials file's state without
// touching the real ~/.claude/.credentials.json on the dev machine.
function stubCreds(t, behavior) {
  t.mock.method(fs, 'readFileSync', () => {
    if (behavior.error) throw behavior.error;
    return JSON.stringify(behavior.contents);
  });
}

// Replaces the Keychain reader so the file-missing path is deterministic on a
// real macOS dev machine (where the live Keychain would otherwise return a
// real token). `value` is the raw JSON string the Keychain would yield, or
// null when no item exists.
function stubKeychain(t, value) {
  t.mock.method(usage, 'readKeychainCreds', () => value);
}

const validCreds = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-pretend-token',
    expiresAt: Date.now() + 3600_000,
    subscriptionType: 'pro',
    rateLimitTier: 'default',
  },
};

test('fetchUsage throws NO_CREDS when the file is missing and the Keychain is empty', async (t) => {
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  stubCreds(t, { error: enoent });
  stubKeychain(t, null);
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'NO_CREDS');
    assert.match(err.message, /Run `claude`/);
    return true;
  });
});

test('fetchUsage reads the token from the macOS Keychain when the file is missing', async (t) => {
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  stubCreds(t, { error: enoent });
  stubKeychain(t, JSON.stringify(validCreds));
  stubFetch(t, makeResponse({
    status: 200,
    json: { five_hour: { utilization: 42, resets_at: '2026-07-01T00:00:00Z' } },
  }));
  const data = await fetchUsage();
  assert.equal(data.limits.length, 1);
  assert.equal(data.subscriptionType, 'pro');
});

test('fetchUsage throws NO_CREDS when claudeAiOauth field is absent', async (t) => {
  stubCreds(t, { contents: { someOtherField: true } });
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'NO_CREDS');
    return true;
  });
});

test('fetchUsage throws NO_CREDS when accessToken is empty', async (t) => {
  stubCreds(t, { contents: { claudeAiOauth: { accessToken: '' } } });
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'NO_CREDS');
    return true;
  });
});

test('fetchUsage surfaces RATE_LIMITED on 429 and honors Retry-After', async (t) => {
  stubCreds(t, { contents: validCreds });
  stubFetch(t, makeResponse({ status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.retryAfter, 120);
    return true;
  });
});

test('fetchUsage defaults Retry-After to 60s when the header is missing', async (t) => {
  stubCreds(t, { contents: validCreds });
  stubFetch(t, makeResponse({ status: 429 }));
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.retryAfter, 60);
    return true;
  });
});

test('fetchUsage throws AUTH_EXPIRED on 401 when retry yields the same token', async (t) => {
  // readToken is called twice on a 401 (the second time to detect a refresh).
  // Returning identical tokens both times triggers the AUTH_EXPIRED path.
  stubCreds(t, { contents: validCreds });
  stubFetch(t, makeResponse({ status: 401 }));
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'AUTH_EXPIRED');
    return true;
  });
});

test('fetchUsage throws HTTP_ERROR on 5xx without leaking the response body', async (t) => {
  stubCreds(t, { contents: validCreds });
  // The body intentionally contains a string that *looks* like a token leak —
  // this asserts we don't echo it into the error message (an Anthropic 4xx
  // body has been observed to include the bearer token in the past).
  stubFetch(t, makeResponse({
    status: 500,
    statusText: 'Internal Server Error',
    text: 'sk-ant-oat01-some-secret-token leaked here',
  }));
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    assert.equal(err.status, 500);
    assert.doesNotMatch(err.message, /sk-ant/);
    assert.match(err.message, /500/);
    return true;
  });
});

test('fetchUsage throws HTTP_ERROR when the body is not valid JSON', async (t) => {
  stubCreds(t, { contents: validCreds });
  stubFetch(t, makeResponse({ status: 200, json: new SyntaxError('Unexpected token <') }));
  await assert.rejects(fetchUsage(), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    assert.match(err.message, /non-JSON/);
    return true;
  });
});

test('fetchUsage returns normalized data on a successful response', async (t) => {
  stubCreds(t, { contents: validCreds });
  stubFetch(t, makeResponse({
    status: 200,
    json: {
      five_hour: { utilization: 42, resets_at: '2026-07-01T00:00:00Z' },
      seven_day: { utilization: 11, resets_at: '2026-07-08T00:00:00Z' },
    },
  }));
  const data = await fetchUsage();
  assert.equal(Array.isArray(data.limits), true);
  assert.equal(data.limits.length, 2);
  assert.equal(data.subscriptionType, 'pro');
  assert.equal(data.rateLimitTier, 'default');
  // fetchedAt is set by normalize() to Date.now() — assert it's recent.
  assert.ok(Math.abs(Date.now() - data.fetchedAt) < 5_000);
});
