// Tests for src/checkout.js -- the piece branch.js deliberately omits:
// actually moving HEAD and rewriting the working tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { createBranch, currentBranch } from '../src/branch.js';
import { checkoutBranch } from '../src/checkout.js';

const AUTHOR = { name: 'jsgit test', email: 'jsgit-test@example.com' };

test('checkoutBranch switches HEAD and updates the working tree', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    const mainBranch = await currentBranch({ dir });
    await createBranch({ dir, name: 'feature' });

    // Prove the working tree actually changes, not just the ref: add a file
    // on feature, commit it, then check that switching branches back and
    // forth makes it appear/disappear on disk.
    const markerPath = path.join(dir, 'feature-marker.txt');
    fs.writeFileSync(markerPath, 'hello from feature\n');
    await git.add({ fs, dir, filepath: 'feature-marker.txt' });
    await git.commit({ fs, dir, ref: `refs/heads/feature`, message: 'add marker', author: AUTHOR });
    // commit({ref}) doesn't touch the working tree or the index by itself,
    // and we haven't switched HEAD yet, so the marker file and the pending
    // add are still just sitting in the working tree/index of mainBranch.
    // Reset the index/working tree back to a clean mainBranch state before
    // testing that checkout is what brings the marker back.
    fs.unlinkSync(markerPath);
    await git.checkout({ fs, dir, ref: mainBranch, force: true });

    assert.equal(fs.existsSync(markerPath), false, 'marker should not exist on mainBranch');

    const result = await checkoutBranch({ dir, ref: 'feature' });
    assert.equal(result.ref, 'feature');
    assert.equal(await currentBranch({ dir }), 'feature');
    assert.equal(fs.existsSync(markerPath), true, 'marker should appear after switching to feature');

    await checkoutBranch({ dir, ref: mainBranch });
    assert.equal(await currentBranch({ dir }), mainBranch);
    assert.equal(fs.existsSync(markerPath), false, 'marker should disappear after switching back');
  });
});

test('checkoutBranch -b creates a new branch and switches to it, refuses to overwrite without force', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    const mainBranch = await currentBranch({ dir });

    await checkoutBranch({ dir, newBranch: 'new-feature' });
    assert.equal(await currentBranch({ dir }), 'new-feature');

    await checkoutBranch({ dir, ref: mainBranch });
    await assert.rejects(checkoutBranch({ dir, newBranch: 'new-feature' }));
    await assert.doesNotReject(checkoutBranch({ dir, newBranch: 'new-feature', force: true }));
    assert.equal(await currentBranch({ dir }), 'new-feature');
  });
});
