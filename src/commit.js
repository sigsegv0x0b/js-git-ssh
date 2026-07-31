// Create a commit from the current index -- deliberately just that, mirroring
// how real git separates `add` (stage) from `commit` (record). The one bit of
// staging this module does on its own is `--all`/`-a`: auto-stage changes to
// files that are ALREADY tracked (modified or deleted), exactly like real
// `git commit -a` -- new, untracked files still require staging separately
// with `jsgit add` (see src/add.js).

import fs from 'node:fs';
import git from 'isomorphic-git';

const FILE = 0;
const HEAD = 1;
const WORKDIR = 2;
const STAGE = 3;

/** Stages modifications/deletions to already-tracked files (HEAD !== 0). Never stages new/untracked files. */
async function stageTrackedChanges({ dir }) {
  const rows = await git.statusMatrix({ fs, dir });
  for (const row of rows) {
    const filepath = row[FILE];
    const head = row[HEAD];
    const workdir = row[WORKDIR];
    const stage = row[STAGE];
    if (head === 0) continue; // never touch untracked files for `-a`
    if (workdir === stage) continue; // already matches what's staged
    if (workdir === 0) {
      await git.remove({ fs, dir, filepath });
    } else {
      await git.add({ fs, dir, filepath });
    }
  }
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} [args.message] - required unless `amend` is true (amend reuses the previous message if omitted)
 * @param {string} [args.authorName] - overrides `user.name` config for this commit
 * @param {string} [args.authorEmail] - overrides `user.email` config for this commit
 * @param {string} [args.committerName] - defaults to the author
 * @param {string} [args.committerEmail] - defaults to the author
 * @param {boolean} [args.all=false] - like `git commit -a`: stage modifications/deletions to tracked files first
 * @param {boolean} [args.amend=false] - replace the previous commit instead of adding a new one
 * @param {boolean} [args.allowEmpty=false] - allow a commit with no changes from its parent (real git also defaults this to false)
 * @returns {Promise<{ oid: string }>}
 */
export async function createCommit({
  dir,
  message,
  authorName,
  authorEmail,
  committerName,
  committerEmail,
  all = false,
  amend = false,
  allowEmpty = false,
}) {
  if (all) {
    await stageTrackedChanges({ dir });
  }
  if (!message && !amend) {
    throw new Error('Commit message is required (-m <message>), unless --amend is reusing the previous one.');
  }

  const author = authorName || authorEmail ? { name: authorName, email: authorEmail } : undefined;
  const committer = committerName || committerEmail ? { name: committerName, email: committerEmail } : undefined;

  const oid = await git.commit({
    fs,
    dir,
    message,
    author,
    committer,
    amend,
    disallowEmpty: !allowEmpty,
  });
  return { oid };
}
