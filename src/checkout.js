// Switch branches: the one thing src/branch.js deliberately doesn't do.
// git.branch() (and this project's createBranch) only ever repoints refs --
// same as real `git branch` -- so actually moving HEAD *and* updating the
// working tree needs isomorphic-git's checkout(), which does both.

import fs from 'node:fs';
import git from 'isomorphic-git';
import { createBranch } from './branch.js';

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} [args.ref] - branch/tag/commit to check out. Required
 *   unless `newBranch` is given. If a matching remote-tracking branch exists
 *   but no local branch does, isomorphic-git creates the local tracking
 *   branch automatically (same as real git).
 * @param {string} [args.newBranch] - like `git checkout -b <newBranch> [<startPoint>]`:
 *   create this branch and switch to it. Fails if it already exists unless
 *   `force` is set (like `-B`).
 * @param {string} [args.startPoint] - with `newBranch`, where to branch from (default: HEAD)
 * @param {boolean} [args.force=false] - overwrite local working-tree changes;
 *   also allows `newBranch` to overwrite an existing branch of that name (`-B`)
 * @param {string} [args.remote='origin'] - remote to track when auto-creating
 *   a local branch from a remote-tracking one
 * @param {(msg: string) => void} [args.onProgress]
 */
export async function checkoutBranch({ dir, ref, newBranch, startPoint, force = false, remote = 'origin', onProgress }) {
  let target = ref;
  if (newBranch) {
    await createBranch({ dir, name: newBranch, startPoint, force });
    target = newBranch;
  }
  await git.checkout({
    fs,
    dir,
    ref: target,
    remote,
    force,
    onProgress: onProgress ? evt => onProgress(`${evt.phase} ${evt.loaded ?? ''}/${evt.total ?? ''}`) : undefined,
  });
  return { ref: target };
}
