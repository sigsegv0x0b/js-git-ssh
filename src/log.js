// Commit history -- a thin wrapper over isomorphic-git's own git.log(),
// which already does the real work (walking commit parents, an optional
// single-path history with rename-following, a commit-count cutoff). This
// module only maps the option names real git's CLI uses onto isomorphic-git's.
//
// git.log()'s `filepath` is a single path, not a pathspec list -- passing more
// than one path isn't supported by isomorphic-git itself, so neither is it
// here.
//
// No `--follow` (rename-following): isomorphic-git's own `follow` support
// silently drops the origin commit of a rename when there's no intervening
// content-modifying commit between creation and rename (a 2-commit chain) --
// confirmed empirically against real `git log --follow` (3-commit chains
// match exactly; 2-commit chains lose the oldest entry). The bug is in
// _log's catch-block bookkeeping: `isOk` is unconditionally reset to `false`
// after a rename is detected via `resolveFileIdInTree`, so the "push the
// last commit before giving up" fallback that would otherwise catch the
// origin commit never fires. That failure is silent (no error, no signal,
// just a shorter list than reality), which is worse than not having the
// feature -- so it isn't exposed here. This mirrors the project's existing
// stance on rename detection generally (see src/diff.js).

import fs from 'node:fs';
import git from 'isomorphic-git';

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string} [args.ref='HEAD']
 * @param {number} [args.maxCount] - limit to this many commits (git's -n/--max-count)
 * @param {string} [args.filepath] - only commits that touched this single path
 * @returns {Promise<Array<{oid: string, commit: {message: string, tree: string, parent: string[],
 *   author: {name: string, email: string, timestamp: number, timezoneOffset: number}, committer: object}}>>}
 */
export async function getLog({ dir, ref = 'HEAD', maxCount, filepath }) {
  // isomorphic-git's own `depth: 0` does NOT mean "zero commits" -- its walk
  // always pushes the starting commit before ever checking the depth cutoff,
  // so depth:0 behaves exactly like "no limit" (confirmed empirically).
  // Real git's `-n 0` shows nothing, so that case is special-cased here.
  if (maxCount === 0) return [];
  return git.log({ fs, dir, ref, depth: maxCount, filepath });
}
