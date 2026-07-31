// Tests for src/add.js against a real (local, network-free) clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { addPaths } from '../src/add.js';

test('addPaths stages a new file, verified with real git status', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');

    await addPaths({ dir, paths: ['new.txt'] });

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), 'A  new.txt');
  });
});

test('addPaths accepts an absolute path that legitimately resolves inside the repo', async () => {
  // Regression test for the path.join-vs-path.resolve gotcha: isomorphic-git's
  // git.add() joins `dir` and `filepath` with plain path.join, which does NOT
  // special-case an absolute second argument the way path.resolve does, so an
  // absolute path must be normalized to dir-relative before reaching git.add().
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    const absPath = path.join(dir, 'abs.txt');
    fs.writeFileSync(absPath, 'hello\n');

    await addPaths({ dir, paths: [absPath] });

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), 'A  abs.txt', 'should stage exactly "abs.txt", not a doubled/mangled path');
  });
});

test('addPaths rejects a relative path that escapes the repository', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await assert.rejects(addPaths({ dir, paths: ['../outside.txt'] }), /outside the repository/);

    // Must not have touched the index at all.
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '');
  });
});

test('addPaths rejects an absolute path that resolves outside the repository', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await assert.rejects(addPaths({ dir, paths: ['/definitely/outside/the/repo.txt'] }), /outside the repository/);
  });
});

test('addPaths requires at least one path', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    await assert.rejects(addPaths({ dir, paths: [] }), /requires at least one/);
  });
});

test('addPaths recurses into directories and stages everything with "."', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    fs.mkdirSync(path.join(dir, 'newdir'));
    fs.writeFileSync(path.join(dir, 'newdir', 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'newdir', 'b.txt'), 'b\n');

    await addPaths({ dir, paths: ['.'] });

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    const lines = status.trim().split('\n').sort();
    assert.deepEqual(lines, ['A  newdir/a.txt', 'A  newdir/b.txt']);
  });
});

test('addPaths on an already-.gitignore\'d file is a silent no-op, not an error', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'should stay untracked\n');

    await assert.doesNotReject(addPaths({ dir, paths: ['ignored.txt'] }));

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });
    assert.match(status, /!! ignored\.txt/, 'ignored.txt should remain ignored/untracked, not staged');
  });
});

test('addPaths --force stages a file matched by .gitignore', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'forced in\n');

    await addPaths({ dir, paths: ['ignored.txt'], force: true });

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.match(status, /A {2}ignored\.txt/);
  });
});
