// Tests for src/branch.js against a real (local, network-free) clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { listBranches, createBranch, deleteBranch, renameBranch } from '../src/branch.js';

const AUTHOR = { name: 'jsgit test', email: 'jsgit-test@example.com' };

test('listBranches reports the current branch after clone', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    const mainBranch = await git.currentBranch({ fs, dir });

    const { branches, current } = await listBranches({ dir });
    assert.equal(current, mainBranch);
    assert.ok(branches.includes(mainBranch));
  });
});

test('createBranch then listBranches shows the new branch', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await createBranch({ dir, name: 'feature-a' });

    const { branches } = await listBranches({ dir });
    assert.ok(branches.includes('feature-a'));
  });
});

test('createBranch refuses to overwrite an existing branch without force', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await createBranch({ dir, name: 'dup' });
    await assert.rejects(createBranch({ dir, name: 'dup' }));
    await assert.doesNotReject(createBranch({ dir, name: 'dup', force: true }));
  });
});

test('deleteBranch succeeds without force on a branch that is trivially up to date with HEAD', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await createBranch({ dir, name: 'feature-a' }); // same tip as HEAD -- trivially merged
    await deleteBranch({ dir, name: 'feature-a' });

    const { branches } = await listBranches({ dir });
    assert.ok(!branches.includes('feature-a'));
  });
});

test('deleteBranch without force refuses a branch with unmerged commits ahead of HEAD, force overrides', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await createBranch({ dir, name: 'feature-b' });
    // Commit directly onto feature-b's ref (no checkout needed) so it moves
    // ahead of HEAD -- this makes it genuinely unmerged.
    await git.commit({
      fs,
      dir,
      ref: 'refs/heads/feature-b',
      message: 'a commit only on feature-b',
      author: AUTHOR,
    });

    await assert.rejects(deleteBranch({ dir, name: 'feature-b' }), /not fully merged/);

    // The branch must still be there after the refused delete.
    let { branches } = await listBranches({ dir });
    assert.ok(branches.includes('feature-b'));

    await deleteBranch({ dir, name: 'feature-b', force: true });
    ({ branches } = await listBranches({ dir }));
    assert.ok(!branches.includes('feature-b'));
  });
});

test('renameBranch renames, and moves HEAD if the current branch was renamed', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    const mainBranch = await git.currentBranch({ fs, dir });

    await renameBranch({ dir, oldName: mainBranch, newName: 'renamed-main' });

    const { branches, current } = await listBranches({ dir });
    assert.ok(!branches.includes(mainBranch));
    assert.ok(branches.includes('renamed-main'));
    assert.equal(current, 'renamed-main');
  });
});

test('renameBranch with force overwrites an existing branch of the target name', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await createBranch({ dir, name: 'target' });
    await createBranch({ dir, name: 'source' });

    await assert.rejects(renameBranch({ dir, oldName: 'source', newName: 'target' }));
    await assert.doesNotReject(renameBranch({ dir, oldName: 'source', newName: 'target', force: true }));

    const { branches } = await listBranches({ dir });
    assert.ok(branches.includes('target'));
    assert.ok(!branches.includes('source'));
  });
});
