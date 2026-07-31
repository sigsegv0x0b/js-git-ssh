// Tests for src/diff.js against a real (local, network-free) clone,
// cross-checked against real `git diff` where possible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { addPaths } from '../src/add.js';
import { diffRepo } from '../src/diff.js';

const AUTHOR = { name: 'jsgit test', email: 'jsgit-test@example.com' };

async function setUserConfig(dir) {
  await git.setConfig({ fs, dir, path: 'user.name', value: AUTHOR.name });
  await git.setConfig({ fs, dir, path: 'user.email', value: AUTHOR.email });
}

/** The actual context/added/removed lines should be the same Myers diff
 * git itself produces. Compares only what comes AFTER each `@@ ... @@`
 * line, not the header line itself: real git appends a "nearest preceding
 * function/section heading" heuristic to it (e.g. "@@ ... @@ function foo()")
 * that jsdiff has no equivalent for -- a real, expected difference between
 * the two diff engines, not something to chase. Also skips our own/real
 * git's `diff --git`/`index`/`---`/`+++` header lines, which are cosmetic. */
function hunkContentLines(patchText) {
  return patchText
    .split('\n')
    .filter(line => !line.startsWith('@@') && !/^(diff --git|index |--- |\+\+\+ )/.test(line))
    .join('\n')
    .trim();
}

test('unstaged diff never leaks .git/** into the results (regression test)', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const tracked = (await git.listFiles({ fs, dir }))[0];
    fs.appendFileSync(path.join(dir, tracked), '\n// modified\n');

    const { files } = await diffRepo({ dir });
    assert.ok(!files.some(f => f.path.startsWith('.git/') || f.path === '.git'), '.git internals must never appear in a diff');
    assert.deepEqual(files.map(f => f.path), [tracked]);
  });
});

test('unstaged diff matches real `git diff` hunk content for a modified file', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const tracked = (await git.listFiles({ fs, dir }))[0];
    fs.appendFileSync(path.join(dir, tracked), 'jsgit test line\n');

    const { files } = await diffRepo({ dir });
    const record = files.find(f => f.path === tracked);
    assert.ok(record, `expected a diff record for ${tracked}`);
    assert.equal(record.status, 'modified');

    const realDiff = execFileSync('git', ['-C', dir, 'diff', '--', tracked], { encoding: 'utf8' });
    assert.equal(hunkContentLines(record.patch), hunkContentLines(realDiff));
  });
});

test('staged vs unstaged: a staged change shows with --cached and disappears from the unstaged view', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const tracked = (await git.listFiles({ fs, dir }))[0];
    fs.appendFileSync(path.join(dir, tracked), 'staged change\n');
    await addPaths({ dir, paths: [tracked] });

    const staged = await diffRepo({ dir, cached: true });
    assert.deepEqual(staged.files.map(f => f.path), [tracked]);

    const unstaged = await diffRepo({ dir });
    assert.equal(unstaged.files.length, 0, 'no unstaged changes remain once everything is staged');
  });
});

test('new file: staged diff shows "added" status with /dev/null old side', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    fs.writeFileSync(path.join(dir, 'brand-new.txt'), 'line1\nline2\n');
    await addPaths({ dir, paths: ['brand-new.txt'] });

    const { files } = await diffRepo({ dir, cached: true });
    const record = files.find(f => f.path === 'brand-new.txt');
    assert.equal(record.status, 'added');
    assert.equal(record.oldOid, undefined);
    assert.match(record.patch, /new file mode \d+/);
    assert.match(record.patch, /--- \/dev\/null/);
    assert.match(record.patch, /\+\+\+ b\/brand-new\.txt/);
  });
});

test('deleted file: diff shows "deleted" status with /dev/null new side', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const tracked = (await git.listFiles({ fs, dir }))[0];
    fs.unlinkSync(path.join(dir, tracked));

    const { files } = await diffRepo({ dir });
    const record = files.find(f => f.path === tracked);
    assert.equal(record.status, 'deleted');
    assert.equal(record.newOid, undefined);
    assert.match(record.patch, /deleted file mode \d+/);
    assert.match(record.patch, /\+\+\+ \/dev\/null/);
  });
});

test('ref-vs-ref diff shows the files introduced between two commits', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);
    const before = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await addPaths({ dir, paths: ['a.txt', 'b.txt'] });
    await git.commit({ fs, dir, message: 'add a and b', author: AUTHOR });
    const after = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    const { files } = await diffRepo({ dir, refs: [before, after] });
    assert.deepEqual(files.map(f => f.path).sort(), ['a.txt', 'b.txt']);
    assert.ok(files.every(f => f.status === 'added'));
  });
});

test('one-ref diff (tree vs workdir) reports both a modification and a deletion', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const [f1, f2] = await git.listFiles({ fs, dir });
    fs.appendFileSync(path.join(dir, f1), '\nmodified\n');
    fs.unlinkSync(path.join(dir, f2));

    const { files } = await diffRepo({ dir, refs: ['HEAD'] });
    const byPath = Object.fromEntries(files.map(f => [f.path, f]));
    assert.equal(byPath[f1]?.status, 'modified');
    assert.equal(byPath[f2]?.status, 'deleted');
  });
});

test('--cached is rejected when two explicit refs are given', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    await assert.rejects(diffRepo({ dir, refs: [head, head], cached: true }), /cannot be combined with two explicit refs/);
  });
});

test('binary files are detected and never text-diffed', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    fs.writeFileSync(path.join(dir, 'binfile.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));

    const { files } = await diffRepo({ dir });
    const record = files.find(f => f.path === 'binfile.bin');
    assert.equal(record.status, 'binary');
    assert.equal(record.patch, null);
  });
});

test('path filtering limits the diff to the given paths', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await addPaths({ dir, paths: ['a.txt', 'b.txt'] });

    const { files } = await diffRepo({ dir, cached: true, paths: ['a.txt'] });
    assert.deepEqual(files.map(f => f.path), ['a.txt']);
  });
});

test('a pure mode change (chmod, no content change) is reported distinctly from a content change', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);
    fs.writeFileSync(path.join(dir, 'exec-test.txt'), 'same content\n');
    await addPaths({ dir, paths: ['exec-test.txt'] });
    await git.commit({ fs, dir, message: 'add exec-test.txt', author: AUTHOR });

    fs.chmodSync(path.join(dir, 'exec-test.txt'), 0o755);
    const { files } = await diffRepo({ dir, paths: ['exec-test.txt'] });
    const record = files.find(f => f.path === 'exec-test.txt');
    assert.equal(record.status, 'mode-changed');
    assert.equal(record.oldOid, record.newOid, 'content/oid should be unchanged');
    assert.match(record.patch, /old mode \d+/);
    assert.match(record.patch, /new mode \d+/);
  });
});

test('an unmodified repo produces no diff records in any mode', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    assert.equal((await diffRepo({ dir })).files.length, 0);
    assert.equal((await diffRepo({ dir, cached: true })).files.length, 0);
  });
});
