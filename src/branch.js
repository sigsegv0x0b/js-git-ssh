// Local branch management: list / create / delete / rename. Mirrors the
// subset of `git branch` that's meaningful without a working-tree checkout
// step (isomorphic-git's own `git.branch({checkout: true})` only repoints
// the HEAD symref -- like real `git branch`, it never touches files -- so
// none of this needs isomorphic-git's `checkout()` machinery).

import fs from 'node:fs';
import git from 'isomorphic-git';

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} [args.remote] - list remote-tracking branches under refs/remotes/<remote> instead of local ones
 * @returns {Promise<{ branches: string[], current?: string }>}
 */
/** @returns {Promise<string|undefined>} the current branch name, or undefined if HEAD is detached */
export async function currentBranch({ dir }) {
  return git.currentBranch({ fs, dir });
}

export async function listBranches({ dir, remote }) {
  const branches = await git.listBranches({ fs, dir, remote });
  const current = remote ? undefined : await git.currentBranch({ fs, dir, fullname: false });
  return { branches, current };
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} args.name - new branch name
 * @param {string} [args.startPoint] - ref/oid to branch from (default: HEAD)
 * @param {boolean} [args.force=false] - overwrite an existing branch of the same name
 */
export async function createBranch({ dir, name, startPoint, force = false }) {
  await git.branch({ fs, dir, ref: name, object: startPoint, force });
}

/**
 * Checks whether `refs/heads/<name>`'s tip is already reachable from HEAD.
 * Returns false (never throws) if this can't be determined -- e.g. a
 * shallow clone's history is truncated before a real common ancestor would
 * be found. That's the safe direction: it's the same case real `git branch
 * -d` would refuse in, requiring `-D` to force it.
 */
async function isMergedIntoHead({ dir, name }) {
  const branchOid = await git.resolveRef({ fs, dir, ref: `refs/heads/${name}` });
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (branchOid === headOid) return true; // trivially merged/up to date
  try {
    // isDescendent(oid, ancestor) is strict (false when oid === ancestor,
    // handled above) and walks parent history looking for `ancestor`.
    return await git.isDescendent({ fs, dir, oid: headOid, ancestor: branchOid, depth: -1 });
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} args.name
 * @param {boolean} [args.force=false] - like `git branch -D`: skip the "is it merged into HEAD?" safety check
 */
export async function deleteBranch({ dir, name, force = false }) {
  if (!force && !(await isMergedIntoHead({ dir, name }))) {
    throw new Error(
      `branch '${name}' is not fully merged into HEAD (or that can't be verified, e.g. in a shallow clone). ` +
        'Use force delete (-D) to delete it anyway.'
    );
  }
  await git.deleteBranch({ fs, dir, ref: name });
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} args.oldName
 * @param {string} args.newName
 * @param {boolean} [args.force=false] - like `git branch -M`: overwrite newName if it already exists
 */
export async function renameBranch({ dir, oldName, newName, force = false }) {
  if (force) {
    const { branches } = await listBranches({ dir });
    if (branches.includes(newName)) {
      await git.deleteBranch({ fs, dir, ref: newName });
    }
  }
  await git.renameBranch({ fs, dir, ref: newName, oldref: oldName });
}
