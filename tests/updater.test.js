const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compareVersions } = require('../src/updater');

test('parseVersion accepts vX.Y.Z and X.Y.Z forms', () => {
  assert.deepEqual(parseVersion('v0.2.10'), [0, 2, 10]);
  assert.deepEqual(parseVersion('0.2.10'), [0, 2, 10]);
  assert.deepEqual(parseVersion('V1.0.0'), [1, 0, 0]);
});

test('parseVersion strips pre-release/build metadata', () => {
  assert.deepEqual(parseVersion('v1.2.3-beta.1'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3+build.5'), [1, 2, 3]);
});

test('parseVersion returns null for malformed tags', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions ranks versions correctly', () => {
  assert.ok(compareVersions([0, 2, 10], [0, 2, 9]) > 0);
  assert.ok(compareVersions([0, 2, 10], [0, 2, 11]) < 0);
  assert.equal(compareVersions([0, 2, 10], [0, 2, 10]), 0);
  assert.ok(compareVersions([1, 0, 0], [0, 99, 99]) > 0);
  // 0.2.10 must outrank 0.2.9 numerically (string sort would lie).
  assert.ok(compareVersions(parseVersion('v0.2.10'), parseVersion('v0.2.9')) > 0);
});

const { summarizeReleases } = require('../src/updater');
const { expectedHash, PORTABLE_NAME_RE } = require('../src/selfUpdate');

test('summarizeReleases counts published releases newer than current', () => {
  const releases = [
    { tag_name: 'v0.2.36' }, { tag_name: 'v0.2.35' }, { tag_name: 'v0.2.34' },
    { tag_name: 'v0.2.33' }, { tag_name: 'v0.2.32' },
    { tag_name: 'v0.3.0', draft: true }, { tag_name: 'v0.2.37-beta', prerelease: true }, { tag_name: 'nightly' },
  ];
  const s = summarizeReleases(releases, [0, 2, 33]);
  assert.equal(s.behind, 3);
  assert.equal(s.latest.release.tag_name, 'v0.2.36');
});

test('summarizeReleases reports 0 behind on the latest and handles empty lists', () => {
  assert.equal(summarizeReleases([{ tag_name: 'v1.0.0' }], [1, 0, 0]).behind, 0);
  assert.equal(summarizeReleases([], [1, 0, 0]), null);
  assert.equal(summarizeReleases(null, [1, 0, 0]), null);
});

test('summarizeReleases picks the highest version regardless of list order', () => {
  const s = summarizeReleases([{ tag_name: 'v0.2.9' }, { tag_name: 'v0.2.10' }], [0, 2, 8]);
  assert.equal(s.latest.release.tag_name, 'v0.2.10');
  assert.equal(s.behind, 2);
});

test('expectedHash finds the hash for an exact file name only', () => {
  const a = 'a'.repeat(64), b = 'B'.repeat(64);
  const sums = `${a}  ClaudeUsageWidget-0.2.36-portable.exe\r\n${b}  ClaudeUsageWidget-0.2.36-setup.exe\r\n`;
  assert.equal(expectedHash(sums, 'ClaudeUsageWidget-0.2.36-setup.exe'), 'b'.repeat(64));
  assert.equal(expectedHash(sums, 'ClaudeUsageWidget-0.2.36-portable.exe'), a);
  assert.equal(expectedHash(sums, 'portable.exe'), null);
});

test('portable cleanup only matches our release file names', () => {
  assert.ok(PORTABLE_NAME_RE.test('ClaudeUsageWidget-0.2.35-portable.exe'));
  assert.ok(!PORTABLE_NAME_RE.test('ClaudeUsageWidget.exe'));
  assert.ok(!PORTABLE_NAME_RE.test('evil-0.2.35-portable.exe'));
});
