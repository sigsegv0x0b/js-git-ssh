// Unit tests for URL parsing and the shim-URL construction it feeds.
// Neither path is exercised by the live SSH test: the scp-like shorthand
// carries no port, and the only reachable live host uses a non-default
// port, so scp-form can't be live-tested against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshUrl } from '../src/clone.js';

// Mirrors the join logic in clone.js's shallowClone().
function buildShimUrl(path) {
  return `http://ssh-shim${path.startsWith('/') ? '' : '/'}${path}`;
}

test('parseSshUrl: ssh:// form with explicit port and absolute path', () => {
  const parsed = parseSshUrl('ssh://git@puppet-git.ppops.net:2222/administration-hiera.git');
  assert.deepEqual(parsed, { user: 'git', host: 'puppet-git.ppops.net', port: 2222, path: '/administration-hiera.git' });
});

test('parseSshUrl: ssh:// form with default port', () => {
  const parsed = parseSshUrl('ssh://git@github.com/foo/bar.git');
  assert.equal(parsed.port, 22);
  assert.equal(parsed.path, '/foo/bar.git');
});

test('parseSshUrl: scp-like shorthand has no leading slash in path', () => {
  const parsed = parseSshUrl('git@github.com:foo/bar.git');
  assert.deepEqual(parsed, { user: 'git', host: 'github.com', port: 22, path: 'foo/bar.git' });
});

test('shim URL join produces exactly one slash regardless of URL form', () => {
  const fromSsh = parseSshUrl('ssh://git@puppet-git.ppops.net:2222/administration-hiera.git');
  const fromScp = parseSshUrl('git@github.com:foo/bar.git');
  assert.equal(buildShimUrl(fromSsh.path), 'http://ssh-shim/administration-hiera.git');
  assert.equal(buildShimUrl(fromScp.path), 'http://ssh-shim/foo/bar.git');
});

test('parseSshUrl rejects unsupported schemes with a clear message', () => {
  assert.throws(() => parseSshUrl('https://github.com/foo/bar.git'), /Unsupported SSH git URL/);
});
