// Shared test helpers: a network-free way to clone/push against real git
// repos using createLocalChannelFactory (child_process, no SSH/keys). Used
// across local.test.js, branch.test.js, and push.test.js.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { createLocalChannelFactory } from '../src/channel.js';
import { createSshTransport } from '../src/transport.js';

export const SOURCE_REPO = process.cwd();

export async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsgit-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Clones `repoPath` into `dir` over a local git-upload-pack child process (no network). */
export async function cloneLocally(repoPath, dir, { depth = 1, singleBranch = true } = {}) {
  const channelFactory = createLocalChannelFactory();
  const transport = createSshTransport({ channelFactory, repoPath });
  try {
    await git.clone({ fs, http: transport, dir, url: 'http://local-shim/repo', singleBranch, depth });
  } finally {
    await transport.dispose();
  }
}

/** Pushes from a local repo `dir` to `repoPath` over a local git-receive-pack child process (no network). */
export async function pushLocally(repoPath, dir, pushArgs) {
  const channelFactory = createLocalChannelFactory();
  const transport = createSshTransport({ channelFactory, repoPath, service: 'git-receive-pack' });
  try {
    return await git.push({ fs, http: transport, dir, url: 'http://local-shim/repo', ...pushArgs });
  } finally {
    await transport.dispose();
  }
}
