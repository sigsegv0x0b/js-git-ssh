// End-to-end test for the git-receive-pack side of transport.js, fully
// offline: a scratch bare repo stands in for "the remote", and both clone
// and push go over createLocalChannelFactory (child_process, no network/
// SSH). This is the receive-pack analog of local.test.js's fetch coverage,
// and the discriminating check for everything push.js/transport.js do
// differently for git-receive-pack vs git-upload-pack (side-band-demuxed
// response, report-status parsing, ref update semantics).
//
// The scratch "remote" is a `git clone --bare` copy of the CWD source repo
// (see helpers.js) made into a tmp dir -- the source itself is never written
// to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, pushLocally, SOURCE_REPO } from './helpers.js';
import { createBranch } from '../src/branch.js';

const AUTHOR = { name: 'jsgit test', email: 'jsgit-test@example.com' };

async function makeBareRemote(root) {
  const bareDir = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '--bare', SOURCE_REPO, bareDir], { stdio: 'pipe' });
  return bareDir;
}

test('push a new branch lands on the remote and is visible to real git', async () => {
  await withTmpDir(async root => {
    const bareDir = await makeBareRemote(root);
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    await cloneLocally(bareDir, workDir, { depth: 1 });

    await createBranch({ dir: workDir, name: 'jsgit-push-test' });
    const newCommitOid = await git.commit({
      fs,
      dir: workDir,
      ref: 'refs/heads/jsgit-push-test',
      message: 'test commit for push',
      author: AUTHOR,
    });

    const result = await pushLocally(bareDir, workDir, { ref: 'jsgit-push-test' });
    assert.equal(result.ok, true, `push should report ok, got: ${JSON.stringify(result)}`);
    assert.equal(result.refs['refs/heads/jsgit-push-test'].ok, true);

    // Verify with real git against the bare "remote", independent of our client.
    const remoteLog = execFileSync('git', ['--git-dir', bareDir, 'log', '-1', '--format=%H', 'jsgit-push-test'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(remoteLog, newCommitOid);

    // The source repo can have pre-existing dangling objects (confirmed via a
    // plain `git clone --bare` with no jsgit involved at all), so fsck
    // parity -- not an empty-output assertion -- is the correct baseline:
    // pushing our new branch must not introduce anything *beyond* that.
    const baselineBareDir = path.join(root, 'baseline.git');
    execFileSync('git', ['clone', '--bare', SOURCE_REPO, baselineBareDir], { stdio: 'pipe' });
    const fsckOut = execFileSync('git', ['--git-dir', bareDir, 'fsck'], { encoding: 'utf8' });
    const fsckBaseline = execFileSync('git', ['--git-dir', baselineBareDir, 'fsck'], { encoding: 'utf8' });
    assert.equal(fsckOut, fsckBaseline, `push should not change fsck output beyond the source repo's own baseline, got: ${fsckOut}`);
  });
});

test('non-fast-forward push is rejected without --force, accepted with it', async () => {
  await withTmpDir(async root => {
    const bareDir = await makeBareRemote(root);
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    await cloneLocally(bareDir, workDir, { depth: 1 });

    await createBranch({ dir: workDir, name: 'jsgit-nff-test' });
    await git.commit({ fs, dir: workDir, ref: 'refs/heads/jsgit-nff-test', message: 'commit 1', author: AUTHOR });
    await pushLocally(bareDir, workDir, { ref: 'jsgit-nff-test' });

    // Rewrite jsgit-nff-test locally to a divergent, non-fast-forward history.
    await git.commit({
      fs,
      dir: workDir,
      ref: 'refs/heads/jsgit-nff-test',
      message: 'divergent commit',
      author: AUTHOR,
      parent: [await git.resolveRef({ fs, dir: workDir, ref: 'HEAD' })],
    });

    await assert.rejects(pushLocally(bareDir, workDir, { ref: 'jsgit-nff-test' }), /not.*fast-forward|force/i);
    await assert.doesNotReject(pushLocally(bareDir, workDir, { ref: 'jsgit-nff-test', force: true }));
  });
});

test('push --delete removes a branch from the remote', async () => {
  await withTmpDir(async root => {
    const bareDir = await makeBareRemote(root);
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    await cloneLocally(bareDir, workDir, { depth: 1 });

    await createBranch({ dir: workDir, name: 'jsgit-delete-test' });
    await pushLocally(bareDir, workDir, { ref: 'jsgit-delete-test' });

    let remoteBranches = execFileSync('git', ['--git-dir', bareDir, 'branch', '--list', 'jsgit-delete-test'], {
      encoding: 'utf8',
    }).trim();
    assert.notEqual(remoteBranches, '', 'branch should exist on remote before delete');

    const result = await pushLocally(bareDir, workDir, { ref: 'jsgit-delete-test', delete: true });
    assert.equal(result.ok, true);

    remoteBranches = execFileSync('git', ['--git-dir', bareDir, 'branch', '--list', 'jsgit-delete-test'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(remoteBranches, '', 'branch should be gone from remote after push --delete');
  });
});
