// Tests for src/commit.js against a real (local, network-free) clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { createCommit } from '../src/commit.js';

async function setUserConfig(dir) {
  await git.setConfig({ fs, dir, path: 'user.name', value: 'jsgit test' });
  await git.setConfig({ fs, dir, path: 'user.email', value: 'jsgit-test@example.com' });
}

test('createCommit records a commit for already-staged changes and advances HEAD', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await setUserConfig(dir);
    const before = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'hello\n');
    await git.add({ fs, dir, filepath: 'new-file.txt' });

    const { oid } = await createCommit({ dir, message: 'add new-file.txt' });
    const after = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    assert.equal(after, oid);
    assert.notEqual(after, before);

    const commit = await git.readCommit({ fs, dir, oid });
    assert.equal(commit.commit.message.trim(), 'add new-file.txt');
    assert.equal(commit.commit.parent[0], before);
  });
});

test('createCommit refuses an empty commit by default, --allow-empty overrides', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await setUserConfig(dir);

    await assert.rejects(createCommit({ dir, message: 'nothing changed' }));
    await assert.doesNotReject(createCommit({ dir, message: 'nothing changed', allowEmpty: true }));
  });
});

test('createCommit requires a message unless amending', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await setUserConfig(dir);
    await assert.rejects(createCommit({ dir, allowEmpty: true }), /message is required/);
  });
});

test('createCommit --all stages modifications and deletions to tracked files, but not new untracked ones', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);

    const tracked = (await git.listFiles({ fs, dir }))[0];
    assert.ok(tracked, 'expected the clone to have at least one tracked file');

    // Modify a tracked file, delete none (deletion covered separately below),
    // and add an untracked file that -a must NOT pick up.
    fs.appendFileSync(path.join(dir, tracked), '\n// modified by test\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'should not be committed\n');

    const { oid } = await createCommit({ dir, message: 'modify tracked file', all: true });
    const commit = await git.readCommit({ fs, dir, oid });
    const changed = await git.readTree({ fs, dir, oid: commit.commit.tree });
    assert.ok(!changed.tree.some(e => e.path === 'untracked.txt'), '-a must not stage new untracked files');

    // The untracked file is still on disk and still untracked afterward.
    assert.equal(fs.existsSync(path.join(dir, 'untracked.txt')), true);
    const status = await git.status({ fs, dir, filepath: 'untracked.txt' });
    assert.equal(status, '*added', 'untracked.txt should remain untracked (present, unstaged)');
  });
});

test('createCommit --all stages deletion of a tracked file', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);

    const tracked = (await git.listFiles({ fs, dir }))[0];
    fs.unlinkSync(path.join(dir, tracked));

    const { oid } = await createCommit({ dir, message: 'delete tracked file', all: true });
    const filesAfter = await git.listFiles({ fs, dir, ref: oid });
    assert.ok(!filesAfter.includes(tracked), `${tracked} should be gone from the new commit's tree`);
  });
});

test('createCommit --amend replaces the previous commit instead of adding a new one', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await setUserConfig(dir);
    const originalHead = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await git.add({ fs, dir, filepath: 'a.txt' });
    const { oid: first } = await createCommit({ dir, message: 'first message' });

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await git.add({ fs, dir, filepath: 'b.txt' });
    const { oid: amended } = await createCommit({ dir, message: 'amended message', amend: true });

    assert.notEqual(amended, first);
    const log = await git.log({ fs, dir, depth: 5 });
    // Still exactly one commit ahead of the original clone tip -- amend replaced, didn't add.
    assert.equal(log[0].oid, amended);
    assert.equal(log[1].oid, originalHead);
    assert.equal(log.length, 2);

    const commit = await git.readCommit({ fs, dir, oid: amended });
    assert.equal(commit.commit.message.trim(), 'amended message');
    const tree = await git.readTree({ fs, dir, oid: commit.commit.tree });
    assert.ok(tree.tree.some(e => e.path === 'a.txt'));
    assert.ok(tree.tree.some(e => e.path === 'b.txt'));
  });
});

test('createCommit honors explicit author overrides', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await setUserConfig(dir);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await git.add({ fs, dir, filepath: 'a.txt' });
    const { oid } = await createCommit({
      dir,
      message: 'custom author',
      authorName: 'Custom Author',
      authorEmail: 'custom@example.com',
    });

    const commit = await git.readCommit({ fs, dir, oid });
    assert.equal(commit.commit.author.name, 'Custom Author');
    assert.equal(commit.commit.author.email, 'custom@example.com');
  });
});
