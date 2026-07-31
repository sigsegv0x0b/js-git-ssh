// Line-level diff between any two of {a commit's tree, the index, the
// working tree} -- the four `git diff` forms all reduce to this. Neither
// isomorphic-git nor this project has a content-diffing primitive
// (isomorphic-git's own `diff3` dependency is merge-only, and `statusMatrix`
// only ever compares oids, never bytes), so we do the tree-walking ourselves
// on isomorphic-git's `walk()`/`TREE()`/`WORKDIR()`/`STAGE()` -- the same
// primitives `statusMatrix()` itself is built on -- and hand the actual
// line-diffing (Myers algorithm) to the `diff` package.
//
// `diff`'s own patch formatting includes a "===...===" underline and an
// "Index:" line that are jsdiff conventions, not git's, and it has no
// concept at all of `diff --git`/`index <a>..<b> <mode>` git-porcelain
// lines. We use `structuredPatch()` + `formatPatch()` for the parts jsdiff
// gets right (correct `@@ -0,0 +n,m @@` handling for new/deleted files,
// "\ No newline at end of file" markers) and strip/synthesize the rest
// ourselves.

import fs from 'node:fs';
import git from 'isomorphic-git';
import { structuredPatch, formatPatch } from 'diff';

const BINARY_SCAN_BYTES = 8000; // matches git's own heuristic

function looksBinary(buf) {
  if (!buf) return false;
  const len = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** formatPatch()'s default output always leads with jsdiff's own
 * "===...===" underline (and, when old/new names match, an "Index:" line --
 * never the case here since we always pass distinct a/ and b/ names). Strip
 * just that decoration; the "---"/"+++"/"@@" lines beneath it are the real
 * unified-diff content and are kept as-is. */
function formatHunkBody({ oldName, newName, oldText, newText, context }) {
  const patch = structuredPatch(oldName, newName, oldText, newText, undefined, undefined, { context });
  if (patch.hunks.length === 0) return null;
  const lines = formatPatch(patch).split('\n');
  if (/^=+$/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

function modeString(mode) {
  return mode != null ? mode.toString(8).padStart(6, '0') : undefined;
}

/** Builds the `diff --git ...` + mode/index header lines, matching real
 * git's four cases (new file, deleted file, mode-only change, normal). */
function buildGitHeader({ filepath, oldMode, newMode, oldOid, newOid }) {
  const lines = [`diff --git a/${filepath} b/${filepath}`];
  const shortOld = oldOid ? oldOid.slice(0, 7) : '0000000';
  const shortNew = newOid ? newOid.slice(0, 7) : '0000000';
  if (oldOid === undefined) {
    lines.push(`new file mode ${modeString(newMode)}`);
    lines.push(`index ${shortOld}..${shortNew}`);
  } else if (newOid === undefined) {
    lines.push(`deleted file mode ${modeString(oldMode)}`);
    lines.push(`index ${shortOld}..${shortNew}`);
  } else if (oldMode !== newMode) {
    lines.push(`old mode ${modeString(oldMode)}`);
    lines.push(`new mode ${modeString(newMode)}`);
    lines.push(`index ${shortOld}..${shortNew}`);
  } else {
    lines.push(`index ${shortOld}..${shortNew} ${modeString(newMode)}`);
  }
  return lines.join('\n');
}

/** Gets a walker entry's content as a Buffer. STAGE() entries never carry
 * content (GitWalkerIndex.content() is always undefined) -- fall back to
 * readBlob() by oid in that case. Returns null for a missing/tree entry. */
async function readEntryBytes({ dir, entry, cache }) {
  if (!entry) return null;
  const type = await entry.type();
  if (type !== 'blob') return null;
  const content = await entry.content();
  if (content !== undefined) return Buffer.from(content);
  const oid = await entry.oid();
  const { blob } = await git.readBlob({ fs, dir, oid, cache });
  return Buffer.from(blob);
}

function toWalker(side) {
  if (side.kind === 'tree') return git.TREE({ ref: side.ref });
  if (side.kind === 'stage') return git.STAGE();
  if (side.kind === 'workdir') return git.WORKDIR({ refresh: false }); // never mutate the index for a diff
  throw new Error(`Unknown diff side kind: ${side.kind}`);
}

function underPaths(filepath, paths) {
  if (!paths || paths.length === 0) return true;
  return paths.some(p => filepath === p || filepath.startsWith(`${p}/`));
}

/**
 * @param {object} args
 * @param {string} args.dir
 * @param {{kind:'tree',ref:string}|{kind:'stage'}|{kind:'workdir'}} args.oldSide
 * @param {{kind:'tree',ref:string}|{kind:'stage'}|{kind:'workdir'}} args.newSide
 * @param {string[]} [args.paths] - limit to these paths (and anything under them)
 * @param {number} [args.context=3] - lines of context around each hunk (git's default is 3;
 *   jsdiff's own default is 4, so this is passed through explicitly, always)
 * @returns {Promise<{ files: Array<{ path: string, status: 'added'|'deleted'|'modified'|'mode-changed'|'binary',
 *   oldMode?: number, newMode?: number, oldOid?: string, newOid?: string, additions: number, deletions: number,
 *   patch: string|null }> }>}
 */
export async function diffTrees({ dir, oldSide, newSide, paths = [], context = 3 }) {
  const cache = {};
  const files = [];

  await git.walk({
    fs,
    dir,
    trees: [toWalker(oldSide), toWalker(newSide)],
    map: async (filepath, [a, b]) => {
      if (filepath === '.') return;

      // Mirror statusMatrix's own guard, and do it FIRST, before even
      // looking at entry types: a path that exists only on the workdir
      // side (absent from whichever other side we're comparing against) is
      // either a genuinely new file or something .gitignore'd -- and
      // isomorphic-git always treats a literal ".git" path as ignored
      // (GitIgnoreManager.isIgnored hard-codes this). Returning `null`
      // here -- not just skipping the entry -- is what prunes descent, so
      // this is also what keeps a workdir-inclusive diff from ever walking
      // into the repo's own object store. Getting this order wrong (e.g.
      // checking it only after already filtering out tree-type entries)
      // lets `.git/**` leak into the diff as a pile of "added" files.
      const workdirEntry = oldSide.kind === 'workdir' ? a : newSide.kind === 'workdir' ? b : undefined;
      const otherEntry = oldSide.kind === 'workdir' ? b : newSide.kind === 'workdir' ? a : undefined;
      if (workdirEntry && !otherEntry && (await git.isIgnored({ fs, dir, filepath }))) {
        return null;
      }

      const aType = a ? await a.type() : undefined;
      const bType = b ? await b.type() : undefined;
      // walk() already recurses into trees on its own; only look at blobs
      // (and the case where a path disappeared entirely, e.g. a file
      // replaced by a directory, which we still want to report on).
      if (aType === 'tree' || bType === 'tree') return;
      if (aType === 'commit' || bType === 'commit') {
        // Submodule entry -- out of scope beyond a one-line placeholder.
        files.push({
          path: filepath,
          status: 'modified',
          additions: 0,
          deletions: 0,
          patch: `diff --git a/${filepath} b/${filepath}\nSubproject commit ${(b && (await b.oid())) || (a && (await a.oid()))}\n`,
        });
        return;
      }

      if (!underPaths(filepath, paths)) return;

      const oldOid = a ? await a.oid() : undefined;
      const newOid = b ? await b.oid() : undefined;
      const oldMode = a ? await a.mode() : undefined;
      const newMode = b ? await b.mode() : undefined;

      if (oldOid === newOid && oldOid !== undefined) {
        if (oldMode !== newMode) {
          files.push({ path: filepath, status: 'mode-changed', oldMode, newMode, oldOid, newOid, additions: 0, deletions: 0, patch: buildGitHeader({ filepath, oldMode, newMode, oldOid, newOid }) + '\n' });
        }
        return; // unchanged content
      }

      const [oldBytes, newBytes] = await Promise.all([
        readEntryBytes({ dir, entry: a, cache }),
        readEntryBytes({ dir, entry: b, cache }),
      ]);

      const status = !a ? 'added' : !b ? 'deleted' : 'modified';
      const record = { path: filepath, status, oldMode, newMode, oldOid, newOid, additions: 0, deletions: 0, patch: null };

      if (looksBinary(oldBytes) || looksBinary(newBytes)) {
        record.status = 'binary';
        files.push(record);
        return;
      }

      const oldText = oldBytes ? oldBytes.toString('utf8') : '';
      const newText = newBytes ? newBytes.toString('utf8') : '';
      const body = formatHunkBody({
        oldName: a ? `a/${filepath}` : '/dev/null',
        newName: b ? `b/${filepath}` : '/dev/null',
        oldText,
        newText,
        context,
      });
      if (body === null) return; // identical text content (shouldn't normally happen once oids differ, but safe)

      for (const line of body.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) record.additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) record.deletions++;
      }
      record.patch = `${buildGitHeader({ filepath, oldMode, newMode, oldOid, newOid })}\n${body}\n`;
      files.push(record);
    },
  });

  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { files };
}

/**
 * Matches real `git diff`'s own combinations of refs/`--cached`:
 *   no refs               -> index vs working tree (unstaged)
 *   no refs, cached       -> HEAD vs index (staged)
 *   one ref               -> <ref>'s tree vs working tree
 *   one ref, cached       -> <ref>'s tree vs index
 *   two refs              -> tree vs tree (`cached` is meaningless/ambiguous here)
 *
 * @param {object} args
 * @param {string} args.dir
 * @param {string[]} [args.refs=[]] - 0, 1, or 2 refs/commits/tags
 * @param {boolean} [args.cached=false]
 * @param {string[]} [args.paths]
 * @param {number} [args.context=3]
 */
export async function diffRepo({ dir, refs = [], cached = false, paths = [], context = 3 }) {
  if (refs.length > 2) {
    throw new Error(`jsgit diff accepts at most 2 refs, got ${refs.length}.`);
  }
  if (refs.length === 2 && cached) {
    throw new Error('--cached cannot be combined with two explicit refs (there is no index/HEAD involved in a ref-to-ref diff).');
  }

  let oldSide, newSide;
  if (refs.length === 2) {
    oldSide = { kind: 'tree', ref: refs[0] };
    newSide = { kind: 'tree', ref: refs[1] };
  } else if (refs.length === 1) {
    oldSide = { kind: 'tree', ref: refs[0] };
    newSide = cached ? { kind: 'stage' } : { kind: 'workdir' };
  } else {
    oldSide = cached ? { kind: 'tree', ref: 'HEAD' } : { kind: 'stage' };
    newSide = cached ? { kind: 'stage' } : { kind: 'workdir' };
  }

  return diffTrees({ dir, oldSide, newSide, paths, context });
}
