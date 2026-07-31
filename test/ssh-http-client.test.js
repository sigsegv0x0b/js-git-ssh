// Tests for src/ssh-http-client.js's GET/POST/auto-dispose state machine,
// exercised offline over a real git-upload-pack child process
// (createLocalChannelFactory) via the injectable `_internals.createHttpClient`
// -- exactly the same no-SSH testing approach transport.js itself uses in
// local.test.js. createSshHttpClient() (the public, SSH-backed entry point)
// is a one-line wrapper around this and is not re-tested here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { createLocalChannelFactory } from '../src/channel.js';
import { withTmpDir, cloneLocally, SOURCE_REPO } from './helpers.js';
import { createBranch } from '../src/branch.js';
import { _internals } from '../src/ssh-http-client.js';

const { createHttpClient } = _internals;

/** A createConnection() that hands out a fresh local channel factory each
 * call and records every one created, so tests can assert exactly when
 * connections open and close. */
function trackedLocalConnections() {
  const factories = [];
  return {
    factories,
    async createConnection() {
      const inner = createLocalChannelFactory();
      let disposed = false;
      const factory = {
        openChannel: cmd => inner.openChannel(cmd),
        async dispose() {
          disposed = true;
          await inner.dispose();
        },
        get disposed() {
          return disposed;
        },
      };
      factories.push(factory);
      return { channelFactory: factory };
    },
  };
}

test('a clone through the client succeeds and disposes its connection exactly once afterward', async () => {
  await withTmpDir(async dir => {
    const { createConnection, factories } = trackedLocalConnections();
    const { http, url } = createHttpClient({ repoPath: SOURCE_REPO, shimUrl: 'http://local-shim/repo', createConnection });

    await git.clone({ fs, http, url, dir, singleBranch: true, depth: 1 });

    assert.equal(factories.length, 1, 'expected exactly one connection for one clone');
    assert.equal(factories[0].disposed, true, 'the connection should be disposed once the clone finishes');

    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    assert.match(headOid, /^[0-9a-f]{40}$/);
  });
});

test('the same client opens a fresh connection for a second, later operation', async () => {
  await withTmpDir(async dirA => {
    await withTmpDir(async dirB => {
      const { createConnection, factories } = trackedLocalConnections();
      const { http, url } = createHttpClient({ repoPath: SOURCE_REPO, shimUrl: 'http://local-shim/repo', createConnection });

      await git.clone({ fs, http, url, dir: dirA, singleBranch: true, depth: 1 });
      await git.clone({ fs, http, url, dir: dirB, singleBranch: true, depth: 1 });

      assert.equal(factories.length, 2, 'each operation should open its own connection');
      assert.ok(factories.every(f => f.disposed), 'both connections should be disposed');
      assert.notEqual(factories[0], factories[1]);
    });
  });
});

test('a discover-only GET (no POST) leaves its connection open until dispose() is called', async () => {
  const { createConnection, factories } = trackedLocalConnections();
  const { http, dispose } = createHttpClient({ repoPath: SOURCE_REPO, shimUrl: 'http://local-shim/repo', createConnection });

  await http.request({ method: 'GET', url: 'http://local-shim/repo/info/refs?service=git-upload-pack' });
  assert.equal(factories.length, 1);
  assert.equal(factories[0].disposed, false, 'nothing should close it while a POST might still follow');

  await dispose();
  assert.equal(factories[0].disposed, true, 'dispose() should close the connection a discover-only call left open');

  await dispose(); // must be safe to call more than once
});

test('two consecutive GETs with no POST between them dispose the first connection', async () => {
  const { createConnection, factories } = trackedLocalConnections();
  const { http, dispose } = createHttpClient({ repoPath: SOURCE_REPO, shimUrl: 'http://local-shim/repo', createConnection });

  await http.request({ method: 'GET', url: 'http://local-shim/repo/info/refs?service=git-upload-pack' });
  await http.request({ method: 'GET', url: 'http://local-shim/repo/info/refs?service=git-upload-pack' });

  assert.equal(factories.length, 2);
  assert.equal(factories[0].disposed, true, 'the first GET-only connection should be closed once a second GET starts');
  assert.equal(factories[1].disposed, false);

  await dispose();
  assert.equal(factories[1].disposed, true);
});

test('a POST with no prior GET on the client is rejected, not silently accepted', async () => {
  const { createConnection } = trackedLocalConnections();
  const { http } = createHttpClient({ repoPath: SOURCE_REPO, shimUrl: 'http://local-shim/repo', createConnection });

  await assert.rejects(
    http.request({ method: 'POST', url: 'http://local-shim/repo/git-upload-pack', body: [] }),
    /POST with no prior GET/
  );
});

test('a failed discovery still disposes the connection instead of leaking it', async () => {
  await withTmpDir(async dir => {
    const { createConnection, factories } = trackedLocalConnections();
    const { http, url } = createHttpClient({ repoPath: '/definitely/not/a/repo', shimUrl: 'http://local-shim/bad', createConnection });

    await assert.rejects(git.clone({ fs, http, url, dir, singleBranch: true, depth: 1 }));

    assert.equal(factories.length, 1);
    assert.equal(factories[0].disposed, true, 'a connection that fails discovery must still be disposed, not leaked');
  });
});

test('the client works correctly for push (git-receive-pack), not just fetch', async () => {
  await withTmpDir(async root => {
    // Mirrors push.test.js's setup: a full (non-shallow) bare remote, and a
    // shallow local clone from it -- pushing a new branch avoids the
    // "shallow update not allowed" rejection a shallow HEAD graft can hit.
    const bareDir = path.join(root, 'remote.git');
    execFileSync('git', ['clone', '--bare', SOURCE_REPO, bareDir], { stdio: 'pipe' });
    const workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    await cloneLocally(bareDir, workDir, { depth: 1 });

    await createBranch({ dir: workDir, name: 'pushed-via-client' });
    await git.commit({
      fs,
      dir: workDir,
      ref: 'refs/heads/pushed-via-client',
      message: 'add file via client',
      author: { name: 'jsgit test', email: 'jsgit-test@example.com' },
      allowEmpty: true,
    });

    const { createConnection, factories } = trackedLocalConnections();
    const { http, url } = createHttpClient({ repoPath: bareDir, shimUrl: 'http://local-shim/bare', createConnection });
    await git.push({ fs, http, url, dir: workDir, ref: 'pushed-via-client', remoteRef: 'pushed-via-client' });

    assert.equal(factories.length, 1);
    assert.equal(factories[0].disposed, true);

    const remoteLog = execFileSync('git', ['-C', bareDir, 'log', '--oneline', 'pushed-via-client'], { encoding: 'utf8' });
    assert.match(remoteLog, /add file via client/);
  });
});
