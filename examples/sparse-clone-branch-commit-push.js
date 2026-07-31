#!/usr/bin/env node
// Example: sparse-clone a repo over SSH, switch to a new branch, add a
// file, commit it, and push the branch back -- using plain `isomorphic-git`
// calls throughout, with this project's SSH transport (src/ssh-http-client.js)
// as the only thing standing in for a real network connection. Nothing here
// depends on jsgit's own clone()/branch()/checkout()/commit() library
// wrappers -- the point of this example is showing that `isomorphic-git`
// itself works completely normally once it's handed `http`/`url` from
// createSshHttpClient(), for a program that wants to drive isomorphic-git
// directly rather than go through jsgit.
//
// Usage:
//   node examples/sparse-clone-branch-commit-push.js <ssh-url> [dir] [sparse-path...]
//
// Example:
//   node examples/sparse-clone-branch-commit-push.js git@github.com:org/repo.git ./example-repo README.md docs
//
// "Sparse clone" here means isomorphic-git's closest equivalent to real
// git's sparse-checkout: it has no `.git/info/sparse-checkout`/cone-mode
// feature at all. What it does have is a `filepaths` option on
// `git.checkout()` that limits which files get written to the working
// tree for THAT ONE checkout call. So: clone with `noCheckout: true` (skip
// the automatic post-clone checkout), then check out only the paths you
// want. The clone's object history is still complete (modulo --depth) --
// only the working tree is sparse, and only until the next checkout that
// doesn't also pass `filepaths` (see the branch-switch step below).

import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { createSshHttpClient } from '../src/ssh-http-client.js';

async function main() {
  const [, , sshUrl, dirArg, ...sparsePathArgs] = process.argv;
  if (!sshUrl) {
    console.error('Usage: node examples/sparse-clone-branch-commit-push.js <ssh-url> [dir] [sparse-path...]');
    console.error('Example: node examples/sparse-clone-branch-commit-push.js git@github.com:org/repo.git ./example-repo README.md docs');
    process.exit(1);
  }

  const dir = path.resolve(dirArg || './example-repo');
  const paths = sparsePathArgs.length > 0 ? sparsePathArgs : ['README.md'];
  const branchName = `jsgit-example-${Date.now()}`;
  const newFile = 'jsgit-example.txt';

  const { http, url } = createSshHttpClient({ url: sshUrl });

  // 1. Sparse clone: skip the automatic post-clone checkout, then check out
  //    only the given paths (see the module doc comment above).
  console.log(`Sparse-cloning ${sshUrl} into ${dir} (paths: ${paths.join(', ')})...`);
  await git.clone({ fs, http, url, dir, depth: 1, singleBranch: true, noCheckout: true });
  await git.checkout({ fs, dir, filepaths: paths });

  // Repair the shim URL isomorphic-git persisted into .git/config: real git
  // tooling needs the actual ssh:// address, not our http://ssh-shim
  // placeholder. jsgit's own clone.js does this same repair after
  // git.clone() for exactly this reason -- see CLAUDE.md.
  await git.setConfig({ fs, dir, path: 'remote.origin.url', value: sshUrl });

  // 2. Switch to a new branch. git.branch() only repoints a ref -- like real
  //    `git branch`, it never touches the working tree -- so an explicit
  //    git.checkout() is what actually moves HEAD and updates files.
  //
  //    NOTE: this checkout doesn't pass `filepaths`, so it's a full,
  //    non-sparse checkout of the new branch (which, branching from HEAD,
  //    has identical content to what a full clone would have had all
  //    along). isomorphic-git's `filepaths` limit above was a one-off for
  //    that specific checkout call, not persistent repo configuration the
  //    way real sparse-checkout's cone-mode patterns are -- keeping a
  //    working tree sparse across every subsequent checkout means passing
  //    `filepaths` again each time.
  console.log(`Creating and switching to branch '${branchName}'...`);
  await git.branch({ fs, dir, ref: branchName });
  await git.checkout({ fs, dir, ref: branchName });

  // 3. Add a new file and commit it.
  console.log(`Adding ${newFile}...`);
  fs.writeFileSync(path.join(dir, newFile), `Created by examples/sparse-clone-branch-commit-push.js at ${new Date().toISOString()}\n`);
  await git.add({ fs, dir, filepath: newFile });

  console.log('Committing...');
  const oid = await git.commit({
    fs,
    dir,
    message: `Add ${newFile} via jsgit example`,
    author: { name: 'jsgit example', email: 'jsgit-example@example.com' },
  });
  console.log(`Committed ${oid.slice(0, 7)}.`);

  // 4. Push the new branch. A fresh SSH connection is opened for this push
  //    and closed automatically once it completes -- see
  //    src/ssh-http-client.js. The same `http`/`url` pair used for the
  //    clone above works here unchanged; no separate connection setup or
  //    manual disposal is needed for either call.
  console.log(`Pushing '${branchName}' to origin...`);
  await git.push({ fs, http, url, dir, ref: branchName, remoteRef: branchName });

  console.log(`\nDone. Pushed branch '${branchName}' to ${sshUrl}.`);
  console.log('Clean it up on the remote when you\'re finished experimenting, e.g.:');
  console.log(`  jsgit push ${sshUrl} :${branchName}`);
}

main().catch(err => {
  console.error(`Example failed: ${err.message}`);
  process.exit(1);
});
