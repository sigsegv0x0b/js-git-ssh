// Tests for src/log.js against a real (local, network-free) clone,
// cross-checked against real `git log` where possible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import git from 'isomorphic-git';

import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { addPaths } from '../src/add.js';
import { getLog } from '../src/log.js';

const AUTHOR = { name: 'jsgit test', email: 'jsgit-test@example.com' };

async function setUserConfig(dir) {
  await git.setConfig({ fs, dir, path: 'user.name', value: AUTHOR.name });
  await git.setConfig({ fs, dir, path: 'user.email', value: AUTHOR.email });
}

test('getLog returns commits newest-first, matching real `git log` oids', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });

    const entries = await getLog({ dir });
    const realOids = execFileSync('git', ['-C', dir, 'log', '--format=%H'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(entries.map(e => e.oid), realOids);
  });
});

test('maxCount limits the number of commits returned', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });

    const entries = await getLog({ dir, maxCount: 2 });
    assert.equal(entries.length, 2);
  });
});

test('maxCount: 0 returns no commits (isomorphic-git\'s own depth:0 means "no limit", not "none")', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    const entries = await getLog({ dir, maxCount: 0 });
    assert.deepEqual(entries, []);
  });
});

test('ref selects the starting point instead of HEAD', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);
    const before = await git.resolveRef({ fs, dir, ref: 'HEAD' });

    fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
    await addPaths({ dir, paths: ['new.txt'] });
    await git.commit({ fs, dir, message: 'add new.txt', author: AUTHOR });

    const fromHead = await getLog({ dir, maxCount: 1 });
    assert.notEqual(fromHead[0].oid, before);

    const fromOldRef = await getLog({ dir, ref: before, maxCount: 1 });
    assert.equal(fromOldRef[0].oid, before);
  });
});

test('filepath limits history to commits that touched that single path', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });
    await setUserConfig(dir);

    fs.writeFileSync(path.join(dir, 'tracked-only.txt'), 'v1\n');
    await addPaths({ dir, paths: ['tracked-only.txt'] });
    await git.commit({ fs, dir, message: 'add tracked-only.txt', author: AUTHOR });

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'v1\n');
    await addPaths({ dir, paths: ['unrelated.txt'] });
    await git.commit({ fs, dir, message: 'add unrelated.txt', author: AUTHOR });

    const entries = await getLog({ dir, filepath: 'tracked-only.txt' });
    assert.deepEqual(entries.map(e => e.commit.message.trim()), ['add tracked-only.txt']);
  });
});

test('a returned commit carries the same author/message shape real git reports', async () => {
  await withTmpDir(async dir => {
    await cloneLocally(SOURCE_REPO, dir, { depth: 5 });

    const [entry] = await getLog({ dir, maxCount: 1 });
    const realSubject = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    const realAuthorName = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%an'], { encoding: 'utf8' }).trim();

    assert.equal(entry.commit.message.split('\n')[0], realSubject);
    assert.equal(entry.commit.author.name, realAuthorName);
  });
});
