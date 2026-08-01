// Protocol-level tests that exercise the exact same transport.js code path
// used for real SSH, but over a local `git-upload-pack` child process
// (createLocalChannelFactory). No network, no SSH keys -- this isolates
// wire-protocol bugs from auth/host-key bugs, per the plan's verification
// step 1.
//
// Source repo: the current working directory (the repo under test), which
// `git-upload-pack` serves read-only and never mutates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { createLocalChannelFactory } from '../src/channel.js';
import { createSshTransport } from '../src/transport.js';
import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';

test('shallow clone via the SSH transport shim (local channel) produces a working repo', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 1 });

    // .git/shallow exists and names the tip commit.
    const shallowFile = path.join(dir, '.git', 'shallow');
    const shallowContents = (await readFile(shallowFile, 'utf8')).trim();
    assert.match(shallowContents, /^[0-9a-f]{40}$/, '.git/shallow should contain a single 40-char oid');

    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    assert.equal(headOid, shallowContents, '.git/shallow tip should match resolved HEAD');

    // Working tree was actually checked out.
    const entries = fs.readdirSync(dir).filter(f => f !== '.git');
    assert.ok(entries.length > 0, 'expected a non-empty checked-out working tree');

    // Exactly one commit of history (depth: 1), per real git.
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).trim();
    assert.equal(log.split('\n').filter(Boolean).length, 1, 'expected exactly 1 commit at depth 1');
  });
});

test('depth-1 clone from the shim is byte-for-byte acceptable to canonical git (fsck parity)', async () => {
  await withTmpDir(async root => {
    const shimDir = path.join(root, 'via-shim');
    const baselineDir = path.join(root, 'via-real-git');
    fs.mkdirSync(shimDir);

    await cloneLocally(SOURCE_REPO, shimDir, { depth: 1 });
    execFileSync('git', ['clone', '--depth', '1', `file://${SOURCE_REPO}`, baselineDir], { stdio: 'pipe' });

    const fsckShim = execFileSync('git', ['-C', shimDir, 'fsck'], { encoding: 'utf8' });
    const fsckBaseline = execFileSync('git', ['-C', baselineDir, 'fsck'], { encoding: 'utf8' });
    assert.equal(fsckShim, fsckBaseline, 'fsck output should match a real git shallow clone (expected: both empty)');
    assert.equal(fsckShim.trim(), '', 'a healthy shallow clone should have no fsck complaints at all');

    // git status must also be clean -- catches checkout/index problems fsck won't.
    const status = execFileSync('git', ['-C', shimDir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status, '', 'working tree should be clean immediately after clone');
  });
});

test('bad repo path surfaces the remote stderr, not a generic empty-response error', async () => {
  await withTmpDir(async dir => {
    const channelFactory = createLocalChannelFactory();
    const transport = createSshTransport({ channelFactory, repoPath: '/definitely/not/a/repo' });
    try {
      await assert.rejects(
        git.clone({ fs, http: transport, dir, url: 'http://local-shim/bad', singleBranch: true, depth: 1 }),
        err => {
          assert.doesNotMatch(err.message, /EmptyServerResponseError/i, 'should not surface as an opaque EmptyServerResponseError');
          assert.match(err.message, /does not appear to be a git repository|no such|not found/i, `expected server stderr in error, got: ${err.message}`);
          return true;
        }
      );
    } finally {
      await transport.dispose();
    }
  });
});

test('createSshTransport rejects a service value that is not a real git service', () => {
  // `service` is spliced unquoted into the remote command, so anything other
  // than the two real git services must be rejected before a channel opens.
  const channelFactory = createLocalChannelFactory();
  assert.throws(
    () => createSshTransport({ channelFactory, repoPath: '/some/repo', service: 'git-upload-pack --foo=bar' }),
    /invalid service/,
    'extra arguments after a valid service name must be rejected'
  );
  // The two real services must still construct fine.
  assert.ok(createSshTransport({ channelFactory, repoPath: '/some/repo', service: 'git-upload-pack' }));
  assert.ok(createSshTransport({ channelFactory, repoPath: '/some/repo', service: 'git-receive-pack' }));
});
