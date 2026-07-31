// Stage files into the index. A thin wrapper over isomorphic-git's own
// git.add() -- which already does the hard parts correctly (recursing into
// directories, respecting .gitignore unless forced, storing symlink targets
// rather than their contents) -- hardened with two checks isomorphic-git
// doesn't do itself:
//
// 1. Containment: git.add({filepath: '../outside.txt'}) is not rejected by
//    isomorphic-git -- it silently writes a bogus index entry pointing
//    outside the repo. We refuse instead of corrupting the index.
// 2. Path form: isomorphic-git joins `filepath` onto `dir` with plain
//    path.join, which -- unlike path.resolve -- does NOT treat an absolute
//    second argument specially. Handing it an absolute path (even one that
//    legitimately lives inside the repo) computes a doubled, wrong path.
//    Every path is normalized to a dir-relative string before it reaches
//    git.add().

import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

/** Resolves `inputPath` against `dir` and returns it as a dir-relative
 * string, throwing if it resolves outside `dir`. */
function toRepoRelativePath(dir, inputPath) {
  const resolved = path.resolve(dir, inputPath);
  const rel = path.relative(dir, resolved) || '.';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to add '${inputPath}': it resolves outside the repository (${dir}).`);
  }
  return rel;
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {string[]} args.paths - one or more paths (files or directories, recursed); use ['.'] for everything
 * @param {boolean} [args.force=false] - like `git add --force`: stage even files matched by .gitignore
 */
export async function addPaths({ dir, paths, force = false }) {
  if (!paths || paths.length === 0) {
    throw new Error('jsgit add requires at least one <path> (use "." to stage everything).');
  }
  const relPaths = paths.map(p => toRepoRelativePath(dir, p));
  await git.add({ fs, dir, filepath: relPaths, force });
}
