#!/usr/bin/env node
// CLI: jsgit clone|branch|push
//
// Pure-JS (no native modules, no `git` binary required) shallow clone,
// branch management, and push over SSH, built on isomorphic-git + ssh2.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { shallowClone, parseSshUrl } from '../src/clone.js';
import { shallowPush } from '../src/push.js';
import { listBranches, createBranch, deleteBranch, renameBranch, currentBranch } from '../src/branch.js';
import { checkoutBranch } from '../src/checkout.js';
import { createCommit } from '../src/commit.js';
import { addPaths } from '../src/add.js';
import { diffRepo } from '../src/diff.js';
import { getLog } from '../src/log.js';

function topUsage() {
  return `Usage: jsgit <command> [options]

Commands:
  clone <ssh-url> [dir]     shallow-clone a repo over SSH
  branch [options] [...]    list/create/delete/rename local branches
  checkout [options] [...]  switch branches (updates HEAD and the working tree)
  add <path>...             stage files into the index
  diff [options]            show changes (unstaged, staged, or between refs)
  log [options] [<ref>]     show commit history
  commit [options]          record a commit from the current index
  push [options] [...]      push a branch (or delete a remote one) over SSH

Run 'jsgit <command> --help' for command-specific options.
`;
}

// isomorphic-git fires onProgress once per object/file, which for a large
// repo means thousands of events -- fine as data, unusable as one-line-per
// message. On a TTY, overwrite a single status line instead (like real git).
function makeProgressLine() {
  return msg => process.stderr.write(`\r\x1b[K${msg}`);
}
function progressReporter() {
  return process.stderr.isTTY ? makeProgressLine() : msg => process.stderr.write(`${msg}\n`);
}

function deriveDirFromUrl(url) {
  const { path: repoPath } = parseSshUrl(url);
  const base = repoPath.split('/').filter(Boolean).pop() || 'repo';
  return base.replace(/\.git$/, '');
}

function cloneUsage() {
  return `Usage: jsgit clone <ssh-url> [dir] [options]

  <ssh-url>              ssh://[user@]host[:port]/path/to/repo.git
                         or the scp-like shorthand: [user@]host:path/to/repo.git
  [dir]                  local directory to clone into (default: derived from repo name)

Options:
  --depth <n>            shallow clone depth (default: 1)
  --branch <ref>         branch/ref to clone (default: remote HEAD)
  --no-single-branch     fetch all branches, not just the target one
  --no-checkout          create the repo but skip working-tree checkout
  --identity <file>      path to an SSH private key file
  --passphrase <pass>    passphrase for an encrypted private key
  --username <user>      SSH username (default: user from URL, else "git")
  --trust-new-hosts      TOFU-accept and remember host keys not already in known_hosts
                         (a host whose key CHANGED is always rejected regardless of this flag)
  --known-hosts <file>   path to known_hosts (default: ~/.ssh/known_hosts)
  -h, --help             show this help
`;
}

async function cmdClone(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      depth: { type: 'string', default: '1' },
      branch: { type: 'string' },
      'single-branch': { type: 'boolean', default: true },
      checkout: { type: 'boolean', default: true },
      identity: { type: 'string' },
      passphrase: { type: 'string' },
      username: { type: 'string' },
      'trust-new-hosts': { type: 'boolean', default: false },
      'known-hosts': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(cloneUsage());
    return;
  }

  const [url, dirArg] = positionals;
  if (!url) throw new Error(`Missing <ssh-url>.\n\n${cloneUsage()}`);

  const dir = path.resolve(dirArg || deriveDirFromUrl(url));
  const result = await shallowClone({
    url,
    dir,
    depth: parseInt(values.depth, 10),
    ref: values.branch,
    singleBranch: values['single-branch'],
    noCheckout: !values.checkout,
    username: values.username,
    identityFile: values.identity,
    passphrase: values.passphrase,
    trustNewHosts: values['trust-new-hosts'],
    knownHostsPath: values['known-hosts'],
    onProgress: progressReporter(),
  });
  if (process.stderr.isTTY) process.stderr.write('\n');
  process.stdout.write(`Cloned ${result.url} into ${result.dir}\n`);
}

function branchUsage() {
  return `Usage: jsgit branch [options] [<name> [<start-point>]]

  (no args)              list local branches (current marked with '*')
  <name> [<start-point>] create a branch named <name> at <start-point> (default: HEAD)

Options:
  -a                     list local and remote-tracking branches
  -r                     list remote-tracking branches only
  --remote <name>        remote to use for -a/-r (default: origin)
  -d, --delete <name>    delete a branch (refuses if not merged into HEAD)
  -D                     delete a branch, even if not merged into HEAD
  -m [<old>] <new>       rename a branch (default <old>: current branch)
  -M [<old>] <new>       rename a branch, overwriting <new> if it exists
  -f, --force            with a bare <name>: overwrite an existing branch
  --dir <path>           repo directory (default: current directory)
  -h, --help             show this help
`;
}

async function cmdBranch(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      delete: { type: 'boolean', short: 'd', default: false },
      'force-delete': { type: 'boolean', short: 'D', default: false },
      rename: { type: 'boolean', short: 'm', default: false },
      'force-rename': { type: 'boolean', short: 'M', default: false },
      all: { type: 'boolean', short: 'a', default: false },
      remotes: { type: 'boolean', short: 'r', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      remote: { type: 'string', default: 'origin' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(branchUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());

  if (values.delete || values['force-delete']) {
    const [name] = positionals;
    if (!name) throw new Error('jsgit branch -d/-D requires a branch name');
    await deleteBranch({ dir, name, force: values['force-delete'] });
    process.stdout.write(`Deleted branch ${name}\n`);
    return;
  }

  if (values.rename || values['force-rename']) {
    const force = values['force-rename'];
    let oldName, newName;
    if (positionals.length >= 2) {
      [oldName, newName] = positionals;
    } else {
      newName = positionals[0];
      oldName = await currentBranch({ dir });
    }
    if (!newName) throw new Error('jsgit branch -m/-M requires a new branch name');
    if (!oldName) throw new Error('Cannot determine current branch to rename (detached HEAD?) -- specify <old> <new> explicitly.');
    await renameBranch({ dir, oldName, newName, force });
    process.stdout.write(`Renamed branch ${oldName} to ${newName}\n`);
    return;
  }

  if (positionals.length > 0) {
    const [name, startPoint] = positionals;
    await createBranch({ dir, name, startPoint, force: values.force });
    process.stdout.write(`Created branch ${name}\n`);
    return;
  }

  // List mode.
  if (values.all || values.remotes) {
    if (!values.remotes) {
      const { branches, current } = await listBranches({ dir });
      for (const b of branches) process.stdout.write(`${b === current ? '* ' : '  '}${b}\n`);
    }
    const { branches: remoteBranches } = await listBranches({ dir, remote: values.remote });
    for (const b of remoteBranches) process.stdout.write(`  remotes/${values.remote}/${b}\n`);
  } else {
    const { branches, current } = await listBranches({ dir });
    for (const b of branches) process.stdout.write(`${b === current ? '* ' : '  '}${b}\n`);
  }
}

function checkoutUsage() {
  return `Usage: jsgit checkout [options] <ref>
       jsgit checkout -b|-B <new-branch> [<start-point>] [options]

  <ref>                  branch, tag, or commit to switch to. If a matching
                         remote-tracking branch exists but no local one does,
                         a local tracking branch is created automatically.

Options:
  -b <new-branch>        create <new-branch> (fails if it already exists) and switch to it
  -B <new-branch>        create <new-branch>, overwriting it if it already exists, and switch to it
  -f, --force            overwrite local working-tree changes; with -B, also overwrite an existing branch
  --remote <name>        remote to track when auto-creating a local branch from a remote-tracking one (default: origin)
  --dir <path>           repo directory (default: current directory)
  -h, --help             show this help
`;
}

async function cmdCheckout(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      branch: { type: 'string', short: 'b' },
      'force-branch': { type: 'string', short: 'B' },
      force: { type: 'boolean', short: 'f', default: false },
      remote: { type: 'string', default: 'origin' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(checkoutUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());
  const newBranch = values.branch || values['force-branch'];
  const force = values.force || Boolean(values['force-branch']);

  let ref, startPoint;
  if (newBranch) {
    [startPoint] = positionals;
  } else {
    [ref] = positionals;
    if (!ref) throw new Error(`Missing <ref> to check out.\n\n${checkoutUsage()}`);
  }

  const result = await checkoutBranch({
    dir,
    ref,
    newBranch,
    startPoint,
    force,
    remote: values.remote,
    onProgress: progressReporter(),
  });
  if (process.stderr.isTTY) process.stderr.write('\n');
  process.stdout.write(`Switched to branch '${result.ref}'\n`);
}

function addUsage() {
  return `Usage: jsgit add <path>... [options]

  <path>...              one or more files or directories to stage (recursed);
                         use "." to stage everything in the repo

Options:
  -f, --force            stage files even if matched by .gitignore
  --dir <path>           repo directory (default: current directory)
  -h, --help             show this help
`;
}

async function cmdAdd(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      force: { type: 'boolean', short: 'f', default: false },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(addUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());
  if (positionals.length === 0) throw new Error(`Missing <path>.\n\n${addUsage()}`);
  await addPaths({ dir, paths: positionals, force: values.force });
}

function diffUsage() {
  return `Usage: jsgit diff [options] [<refA> [<refB>]] [-- <path>...]

  (no refs)              diff the working tree against the index (unstaged changes)
  --cached               diff the index against HEAD instead (staged changes)
  <refA>                 diff the working tree (or index, with --cached) against <refA>
  <refA> <refB>          diff <refA>'s tree against <refB>'s tree (--cached is an error here)
  -- <path>...           limit the diff to these paths (and anything under them)

Options:
  --cached, --staged      diff the index instead of the working tree
  -U <n>, --context <n>  lines of context around each change (default: 3)
  --stat                  show a summary of changes per file instead of the full patch
  --dir <path>            repo directory (default: current directory)
  -h, --help              show this help
`;
}

function formatStat(files) {
  const maxPathLen = Math.max(0, ...files.map(f => f.path.length));
  const maxChanges = Math.max(1, ...files.map(f => f.additions + f.deletions));
  const barWidth = 20;
  // Scale DOWN only when the largest file's change count exceeds the bar
  // width; never scale small numbers UP to fill it (a 1-line change should
  // render as one '+', not a full 20-character bar).
  const scale = maxChanges > barWidth ? barWidth / maxChanges : 1;
  let totalAdd = 0;
  let totalDel = 0;
  const lines = files.map(f => {
    totalAdd += f.additions;
    totalDel += f.deletions;
    if (f.status === 'binary') return ` ${f.path.padEnd(maxPathLen)} | Bin`;
    const total = f.additions + f.deletions;
    const scaled = total === 0 ? 0 : Math.max(1, Math.round(total * scale));
    const addChars = total === 0 ? 0 : Math.round((f.additions / total) * scaled);
    const bar = '+'.repeat(addChars) + '-'.repeat(scaled - addChars);
    return ` ${f.path.padEnd(maxPathLen)} | ${String(total).padStart(3)} ${bar}`;
  });
  lines.push(` ${files.length} file${files.length === 1 ? '' : 's'} changed, ${totalAdd} insertion${totalAdd === 1 ? '' : 's'}(+), ${totalDel} deletion${totalDel === 1 ? '' : 's'}(-)`);
  return lines.join('\n') + '\n';
}

async function cmdDiff(rest) {
  // Node's parseArgs swallows a literal "--" token and flattens everything
  // after it into the same `positionals` array with no marker of where the
  // split was -- so the ref/path split must happen before parseArgs ever
  // sees the args, not after.
  const dashDashIdx = rest.indexOf('--');
  const optsAndRefs = dashDashIdx === -1 ? rest : rest.slice(0, dashDashIdx);
  const pathArgs = dashDashIdx === -1 ? [] : rest.slice(dashDashIdx + 1);

  const { values, positionals: refs } = parseArgs({
    args: optsAndRefs,
    allowPositionals: true,
    options: {
      cached: { type: 'boolean', default: false },
      staged: { type: 'boolean', default: false },
      context: { type: 'string', short: 'U' },
      stat: { type: 'boolean', default: false },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(diffUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());
  const { files } = await diffRepo({
    dir,
    refs,
    cached: values.cached || values.staged,
    paths: pathArgs,
    context: values.context ? parseInt(values.context, 10) : 3,
  });

  if (files.length === 0) return;

  if (values.stat) {
    process.stdout.write(formatStat(files));
    return;
  }

  for (const file of files) {
    if (file.status === 'binary') {
      process.stdout.write(`diff --git a/${file.path} b/${file.path}\nBinary files a/${file.path} and b/${file.path} differ\n`);
    } else {
      process.stdout.write(file.patch);
    }
  }
}

function logUsage() {
  return `Usage: jsgit log [options] [<ref>] [-- <path>]

  [<ref>]                start from this branch/tag/commit instead of HEAD
  -- <path>               only show commits that touched this single path

Options:
  -n <count>, --max-count <count>   limit to this many commits
  --oneline                          one line per commit: abbreviated oid + subject
  --dir <path>                       repo directory (default: current directory)
  -h, --help                         show this help
`;
}

// Matches real git's asctime-style default date format, e.g.
// "Fri May 15 09:24:04 2026 -0700" -- computed in the commit's OWN recorded
// timezone (author.timezoneOffset), not the reader's local timezone.
// timezoneOffset follows JS's Date.getTimezoneOffset() convention: positive
// means west of UTC, so local wall-clock time = UTC time - offset.
function formatCommitDate({ timestamp, timezoneOffset }) {
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const local = new Date(timestamp * 1000 - timezoneOffset * 60000);
  const day = String(local.getUTCDate()).padStart(2, ' ');
  const time = [local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
  const sign = timezoneOffset > 0 ? '-' : '+';
  const abs = Math.abs(timezoneOffset);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${WEEKDAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${day} ${time} ${local.getUTCFullYear()} ${offset}`;
}

// git indents every line of the message body with 4 spaces -- including
// blank lines within the message, which become "    " rather than "".
function formatCommitEntry({ oid, commit }) {
  const lines = [`commit ${oid}`];
  if (commit.parent.length > 1) {
    lines.push(`Merge: ${commit.parent.map(p => p.slice(0, 7)).join(' ')}`);
  }
  lines.push(`Author: ${commit.author.name} <${commit.author.email}>`, `Date:   ${formatCommitDate(commit.author)}`, '');
  for (const line of commit.message.replace(/\n$/, '').split('\n')) {
    lines.push(line.length ? `    ${line}` : '    ');
  }
  return lines.join('\n');
}

function formatCommitOneline({ oid, commit }) {
  const subject = commit.message.split('\n')[0];
  return `${oid.slice(0, 7)} ${subject}`;
}

// parseInt('0', 10) and parseInt('abc', 10) (NaN) are both falsy/invalid in
// ways that must not silently fall back to "no limit" -- `-n 0` should show
// nothing, and a garbage value should error, not walk the whole history.
function parseMaxCount(raw) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--max-count/-n must be a non-negative integer, got '${raw}'.`);
  }
  return n;
}

async function cmdLog(rest) {
  // Same "-- swallowed by parseArgs" workaround as cmdDiff: split on a
  // literal "--" before parseArgs ever sees the args.
  const dashDashIdx = rest.indexOf('--');
  const optsAndRef = dashDashIdx === -1 ? rest : rest.slice(0, dashDashIdx);
  const pathArgs = dashDashIdx === -1 ? [] : rest.slice(dashDashIdx + 1);
  if (pathArgs.length > 1) {
    throw new Error('jsgit log only supports a single <path> filter.');
  }

  const { values, positionals: refs } = parseArgs({
    args: optsAndRef,
    allowPositionals: true,
    options: {
      'max-count': { type: 'string', short: 'n' },
      oneline: { type: 'boolean', default: false },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(logUsage());
    return;
  }
  if (refs.length > 1) {
    throw new Error(`jsgit log accepts at most one <ref>, got ${refs.length}.`);
  }

  const dir = path.resolve(values.dir || process.cwd());
  const entries = await getLog({
    dir,
    ref: refs[0],
    maxCount: parseMaxCount(values['max-count']),
    filepath: pathArgs[0],
  });

  if (entries.length === 0) return;

  if (values.oneline) {
    process.stdout.write(entries.map(formatCommitOneline).join('\n') + '\n');
  } else {
    process.stdout.write(entries.map(formatCommitEntry).join('\n\n') + '\n');
  }
}

function commitUsage() {
  return `Usage: jsgit commit -m <message> [options]

Options:
  -m, --message <msg>    commit message (required unless --amend reuses the previous one)
  -a, --all               stage modifications/deletions to already-tracked files first
                          (like real 'git commit -a' -- new untracked files still need
                          staging separately first, e.g. with 'jsgit add')
  --amend                 replace the previous commit instead of adding a new one
  --allow-empty           allow a commit with no changes from its parent
  --author <name>         author name (default: 'user.name' from .git/config)
  --author-email <email>  author email (default: 'user.email' from .git/config)
  --dir <path>            repo directory (default: current directory)
  -h, --help              show this help
`;
}

async function cmdCommit(rest) {
  const { values } = parseArgs({
    args: rest,
    options: {
      message: { type: 'string', short: 'm' },
      all: { type: 'boolean', short: 'a', default: false },
      amend: { type: 'boolean', default: false },
      'allow-empty': { type: 'boolean', default: false },
      author: { type: 'string' },
      'author-email': { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(commitUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());
  const { oid } = await createCommit({
    dir,
    message: values.message,
    authorName: values.author,
    authorEmail: values['author-email'],
    all: values.all,
    amend: values.amend,
    allowEmpty: values['allow-empty'],
  });

  const branch = await currentBranch({ dir });
  process.stdout.write(`[${branch || 'detached HEAD'} ${oid.slice(0, 7)}] ${(values.message || '(amended)').split('\n')[0]}\n`);
}

function pushUsage() {
  return `Usage: jsgit push [<remote>] [<refspec>] [options]

  <remote>               remote name (default: origin), as configured via 'jsgit clone'
                         or 'git remote add' (reads remote.<name>.url from .git/config)
  <refspec>              <local-branch>[:<remote-branch>]  push <local-branch>
                         :<remote-branch>                  delete <remote-branch> on the remote
                         (default: current branch, pushed to the same name)

Options:
  -f, --force            allow a non-fast-forward update
  --delete               delete <refspec> (or the bare name given) on the remote
  --dir <path>           local repo directory (default: current directory)
  --url <ssh-url>        override the remote URL instead of reading it from .git/config
  --identity <file>      path to an SSH private key file
  --passphrase <pass>    passphrase for an encrypted private key
  --username <user>      SSH username (default: user from URL, else "git")
  --trust-new-hosts      TOFU-accept and remember host keys not already in known_hosts
  --known-hosts <file>   path to known_hosts (default: ~/.ssh/known_hosts)
  -h, --help             show this help
`;
}

async function cmdPush(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      force: { type: 'boolean', short: 'f', default: false },
      delete: { type: 'boolean', default: false },
      dir: { type: 'string' },
      url: { type: 'string' },
      identity: { type: 'string' },
      passphrase: { type: 'string' },
      username: { type: 'string' },
      'trust-new-hosts': { type: 'boolean', default: false },
      'known-hosts': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(pushUsage());
    return;
  }

  const dir = path.resolve(values.dir || process.cwd());
  const [remote = 'origin', refspecArg] = positionals;

  let ref, remoteRef;
  let del = values.delete;
  if (refspecArg) {
    if (refspecArg.startsWith(':')) {
      remoteRef = refspecArg.slice(1);
      del = true;
    } else if (refspecArg.includes(':')) {
      [ref, remoteRef] = refspecArg.split(':');
    } else if (del) {
      // `push origin --delete <name>`: <name> names the REMOTE ref, per real git.
      remoteRef = refspecArg;
    } else {
      ref = refspecArg;
    }
  }

  const result = await shallowPush({
    dir,
    remote,
    ref,
    remoteRef,
    force: values.force,
    delete: del,
    url: values.url,
    username: values.username,
    identityFile: values.identity,
    passphrase: values.passphrase,
    trustNewHosts: values['trust-new-hosts'],
    knownHostsPath: values['known-hosts'],
    onProgress: progressReporter(),
    onMessage: msg => process.stderr.write(`remote: ${msg}\n`),
  });
  if (process.stderr.isTTY) process.stderr.write('\n');

  const refLines = Object.entries(result.refs || {})
    .map(([r, v]) => `${v.ok ? (del ? '-' : ' ') : '!'} ${r}${v.ok ? '' : ` (${v.error})`}`)
    .join('\n');
  const verb = del ? 'Delete' : 'Push';
  process.stdout.write(`${verb} ${result.ok ? 'succeeded' : 'completed with errors'}${refLines ? ':\n' + refLines : ''}\n`);
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(topUsage());
    process.exitCode = command ? 0 : 1;
    return;
  }

  const handlers = { clone: cmdClone, branch: cmdBranch, checkout: cmdCheckout, add: cmdAdd, diff: cmdDiff, log: cmdLog, commit: cmdCommit, push: cmdPush };
  const handler = handlers[command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n\n${topUsage()}`);
    process.exitCode = 1;
    return;
  }

  try {
    await handler(rest);
  } catch (err) {
    process.stderr.write(`jsgit ${command} failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`jsgit: unexpected error: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
