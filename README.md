# jsgit

**All the git logic lives in [`isomorphic-git`](https://isomorphic-git.org/)** — the hard work of object storage, refs, index/working-tree handling, packing, and protocol framing is done entirely by that library. This project is a small add-on around it, contributing exactly one thing: an **SSH transport** that isomorphic-git lacks out of the box.

isomorphic-git ships only HTTP(S) transports. This project implements an isomorphic-git-compatible `http` client shim that speaks `git-upload-pack`/`git-receive-pack` over an [`ssh2`](https://github.com/mscdex/ssh2) exec channel instead of real HTTP. On top of that shim sits a thin CLI (`jsgit`) for Node — no native modules, no `git` binary required — that clones, branches, checks out, and pushes over SSH, delegating every git operation back to isomorphic-git.

## Install

```sh
npm install
```

`.npmrc` sets `omit=optional`, so `ssh2`'s optional native helpers are never built — the install stays pure-JS.

## Using this SSH transport with your own isomorphic-git code

If you're driving `isomorphic-git` directly in another Node program — not through jsgit's own `shallowClone`/`shallowPush`/etc. — `src/ssh-http-client.js` exposes the SSH transport as a plain isomorphic-git `http` client you can pass into any `isomorphic-git` call:

```js
import fs from 'node:fs';
import git from 'isomorphic-git';
import { createSshHttpClient } from './src/ssh-http-client.js';

const { http, url, dispose } = createSshHttpClient({ url: 'git@github.com:org/repo.git' });

await git.clone({ fs, http, url, dir: './repo', depth: 1 });   // closes its own connection when done
await git.push({ fs, http, url, dir: './repo', ref: 'main' }); // same client, a brand-new connection

const refs = await git.listServerRefs({ http, url });          // discover-only: no POST, so...
await dispose();                                                // ...call this or the connection lingers
```

`createSshHttpClient()` accepts the same connection options as `jsgit clone`/`jsgit push` (`username`, `identityFile`, `passphrase`, `trustNewHosts`, `knownHostsPath`, `onProgress`).

**Connection lifecycle is per-operation, not persistent** — deliberately, so nothing needs to be tracked or closed across a whole program's lifetime the way a normal `http` client's keep-alive connection would be:
- `git.clone`/`git.fetch`/`git.push` each open a fresh SSH connection and close it automatically once that operation's response has been fully read — success or failure, it doesn't linger.
- The same `http`/`url` pair can be reused for as many separate operations as you like; each one gets its own connection, not a shared/persistent one.
- **Exception:** isomorphic-git's discover-only calls (`git.listServerRefs`, `getRemoteInfo`/`getRemoteInfo2`) issue a request but never a follow-up, so there's no "operation finished" moment to hook a close onto. Call the client's `dispose()` after one of these if no further clone/fetch/push on the same client is coming — otherwise that connection is left open indefinitely. A subsequent GET on the same client (another discover-only call, or the start of a clone/fetch/push) also closes it automatically, so this only matters for the last operation on a client.
- Not safe for concurrent operations on one client instance — it tracks a single in-flight connection, and a second concurrent operation will tear down the first's. Create a separate `createSshHttpClient()` call per concurrent operation.

See `examples/` for a full walkthrough (sparse clone, branch, add, commit, push) built entirely on plain `isomorphic-git` calls plus this transport.

## CLI

```sh
node bin/jsgit.js <command> [options]
```

Or, after `npm link` (or installing globally), just `jsgit <command>`.

### `jsgit clone`

```sh
jsgit clone <ssh-url> [dir] [options]
```

- `<ssh-url>` — `ssh://[user@]host[:port]/path/to/repo.git`, or the scp-like shorthand `[user@]host:path/to/repo.git`
- `[dir]` — local directory to clone into (default: derived from the repo name)

| Option | Description |
| --- | --- |
| `--depth <n>` | Shallow clone depth (default: `1`) |
| `--branch <ref>` | Branch/ref to clone (default: remote HEAD) |
| `--no-single-branch` | Fetch all branches, not just the target one |
| `--no-checkout` | Create the repo but skip the working-tree checkout |
| `--identity <file>` | Path to an SSH private key file |
| `--passphrase <pass>` | Passphrase for an encrypted private key |
| `--username <user>` | SSH username (default: user from URL, else `git`) |
| `--trust-new-hosts` | TOFU-accept and remember host keys not already in `known_hosts` (a host whose key **changed** is always rejected, regardless of this flag) |
| `--known-hosts <file>` | Path to `known_hosts` (default: `~/.ssh/known_hosts`) |

```sh
jsgit clone git@github.com:org/repo.git --depth 1
jsgit clone ssh://git@example.com:2222/org/repo.git ./mycopy --branch main
```

After cloning, `git remote -v` in the resulting repo shows the real `ssh://` URL — not an internal placeholder — so `git fetch`/`git pull` with real git work normally afterward.

### `jsgit branch`

```sh
jsgit branch [options] [<name> [<start-point>]]
```

| Form | Description |
| --- | --- |
| *(no args)* | List local branches (current marked with `*`) |
| `-a` | List local and remote-tracking branches |
| `-r` | List remote-tracking branches only (`--remote <name>` selects which, default `origin`) |
| `<name> [<start-point>]` | Create a branch named `<name>` at `<start-point>` (default: HEAD); `-f`/`--force` to overwrite an existing one |
| `-d <name>` | Delete a branch — refuses if it isn't fully merged into HEAD |
| `-D <name>` | Delete a branch regardless of merge status |
| `-m [<old>] <new>` | Rename a branch (default `<old>`: current branch) |
| `-M [<old>] <new>` | Rename, overwriting `<new>` if it already exists |

`--dir <path>` selects the repo directory (default: current directory).

```sh
jsgit branch                      # list
jsgit branch feature/x            # create
jsgit branch -d feature/x         # delete (safe)
jsgit branch -m old-name new-name # rename
```

Note: like real `git branch`, none of this touches the working tree — creating or renaming a branch never checks it out. Use `jsgit checkout` to actually switch.

### `jsgit checkout`

```sh
jsgit checkout [options] <ref>
jsgit checkout -b|-B <new-branch> [<start-point>] [options]
```

Switches branches: updates HEAD *and* rewrites the working tree to match, unlike `jsgit branch`.

| Form | Description |
| --- | --- |
| `<ref>` | Switch to an existing branch, tag, or commit. If a matching remote-tracking branch exists but no local branch does, a local tracking branch is created automatically (same as real git) |
| `-b <new-branch> [<start-point>]` | Create `<new-branch>` (fails if it already exists) and switch to it |
| `-B <new-branch> [<start-point>]` | Create `<new-branch>`, overwriting it if it already exists, and switch to it |
| `-f`, `--force` | Overwrite local working-tree changes |

`--dir <path>` and `--remote <name>` (for auto-created tracking branches, default `origin`) are also available.

```sh
jsgit checkout main                 # switch to an existing branch
jsgit checkout -b feature/x         # create + switch
jsgit checkout -B feature/x main    # create/reset feature/x at main, switch to it
```

### `jsgit commit`

```sh
jsgit commit -m <message> [options]
```

Records a commit from the current index — deliberately just that, mirroring how real git separates `add` (stage) from `commit` (record). Use `jsgit add` to stage new files, then `jsgit commit` to record them.

| Option | Description |
| --- | --- |
| `-m`, `--message <msg>` | Commit message (required unless `--amend` reuses the previous one) |
| `-a`, `--all` | Stage modifications/deletions to already-tracked files first (like real `git commit -a`) — new untracked files still need staging separately |
| `--amend` | Replace the previous commit instead of adding a new one |
| `--allow-empty` | Allow a commit with no changes from its parent (refused by default, matching real git) |
| `--author <name>` / `--author-email <email>` | Override `user.name`/`user.email` from `.git/config` for this commit |
| `--dir <path>` | Repo directory (default: current directory) |

```sh
jsgit add newfile.txt
jsgit commit -m "add newfile.txt"
jsgit commit -a -m "update existing files"
jsgit commit --amend -m "fixed message"
```

### `jsgit add`

```sh
jsgit add <path>... [options]
```

Stages files into the index — the counterpart to `commit -a`'s "already-tracked files only" limitation. Recurses into directories; `.` stages everything under the repo root.

| Option | Description |
| --- | --- |
| `-f`, `--force` | Stage a file even if `.gitignore` would otherwise exclude it |
| `--dir <path>` | Repo directory (default: current directory) |

```sh
jsgit add newfile.txt
jsgit add src/ docs/
jsgit add .                        # stage everything
jsgit add --force ignored-but-wanted.txt
```

Paths are validated to resolve inside the repository — a path that would land outside it (`../elsewhere.txt`, or an absolute path outside `--dir`) is rejected with an error rather than silently mis-staged.

### `jsgit diff`

```sh
jsgit diff [options] [<refA> [<refB>]] [-- <path>...]
```

Pure-JS unified diff — no `diff` or `git` binary involved. Supports all of real git's ref/`--cached` combinations:

| Form | Compares |
| --- | --- |
| *(no args)* | Working tree vs. the index (unstaged changes) |
| `--cached` / `--staged` | The index vs. HEAD (staged changes) |
| `<refA>` | Working tree (or the index, with `--cached`) vs. `<refA>`'s tree |
| `<refA> <refB>` | `<refA>`'s tree vs. `<refB>`'s tree (`--cached` is an error here — there's no index/HEAD in a tree-to-tree diff) |
| `-- <path>...` | Limit the diff to these paths (and anything under them) |

| Option | Description |
| --- | --- |
| `--cached`, `--staged` | Diff the index instead of the working tree |
| `-U <n>`, `--context <n>` | Lines of context around each change (default: `3`, matching real git) |
| `--stat` | Print a per-file `+`/`-` summary instead of the full patch |
| `--dir <path>` | Repo directory (default: current directory) |

```sh
jsgit diff                         # unstaged changes
jsgit diff --cached                # staged changes
jsgit diff main                    # working tree vs. main
jsgit diff v1.0 v2.0 -- src/       # two tags, limited to src/
jsgit diff --stat
```

Binary files (detected by a NUL byte in the first 8000 bytes, matching git's own heuristic) are reported as `Binary files a/<path> and b/<path> differ`, never text-diffed. A pure mode change (e.g. `chmod +x` with no content change) is reported as `old mode`/`new mode` lines with no hunk body. Rename detection is out of scope — a rename shows as an unrelated delete + add, same as it would from `git diff --no-renames`.

### `jsgit log`

```sh
jsgit log [options] [<ref>] [-- <path>]
```

Shows commit history, newest first — output matches real `git log` byte-for-byte for both the default and `--oneline` formats.

| Form | Description |
| --- | --- |
| *(no args)* | Start from HEAD |
| `<ref>` | Start from this branch, tag, or commit instead |
| `-- <path>` | Only commits that touched this single path (multiple paths aren't supported) |

| Option | Description |
| --- | --- |
| `-n <count>`, `--max-count <count>` | Limit to this many commits (`-n 0` shows nothing, matching real git) |
| `--oneline` | One line per commit: abbreviated (7-char) oid + subject |
| `--dir <path>` | Repo directory (default: current directory) |

```sh
jsgit log                          # full history from HEAD
jsgit log -n 5                     # last 5 commits
jsgit log --oneline main           # one-line-per-commit, starting from main
jsgit log -- src/diff.js           # history of a single file
```

No `--follow`: rename-following isn't offered because isomorphic-git's own implementation of it silently drops the origin commit of a rename in short history chains — see `CLAUDE.md` for the specifics. `-- <path>` without `--follow` still works exactly like real git's `git log -- <path>` (no rename-following).

### `jsgit push`

```sh
jsgit push [<remote>] [<refspec>] [options]
```

- `<remote>` — remote name (default `origin`), read from `remote.<name>.url` in `.git/config` (as set by `jsgit clone`, or `git remote add`)
- `<refspec>` — `<local-branch>[:<remote-branch>]` to push, or `:<remote-branch>` to delete that branch on the remote. Defaults to the current branch, pushed under the same name.

| Option | Description |
| --- | --- |
| `-f`, `--force` | Allow a non-fast-forward update |
| `--delete` | Delete the given ref on the remote instead of updating it |
| `--dir <path>` | Local repo directory (default: current directory) |
| `--url <ssh-url>` | Override the remote URL instead of reading it from `.git/config` |
| `--identity`, `--passphrase`, `--username`, `--trust-new-hosts`, `--known-hosts` | Same as `clone` |

```sh
jsgit push                        # push current branch to origin
jsgit push origin feature/x       # push a specific branch
jsgit push origin feature/x --force
jsgit push origin :feature/x      # delete feature/x on the remote
jsgit push origin --delete feature/x   # equivalent
```

### Host key verification

All commands verify the server's host key against `~/.ssh/known_hosts` (hashed and plaintext entries, `[host]:port` form supported). By default, an unknown host is refused. Pass `--trust-new-hosts` to trust-on-first-use: the key is verified and appended to `known_hosts`. A host whose key **changed** from what's on record is always a hard failure — `--trust-new-hosts` never overrides that, since a changed key on an already-known host is the actual thing TOFU exists to catch.

## Library usage

The CLI is a thin wrapper. The underlying functions are usable directly:

```js
import { shallowClone } from './src/clone.js';
import { shallowPush } from './src/push.js';
import { listBranches, createBranch, deleteBranch, renameBranch } from './src/branch.js';
import { checkoutBranch } from './src/checkout.js';
import { createCommit } from './src/commit.js';
import { addPaths } from './src/add.js';
import { diffRepo } from './src/diff.js';
import { getLog } from './src/log.js';

await shallowClone({ url: 'git@github.com:org/repo.git', dir: './repo', depth: 1 });

const { branches, current } = await listBranches({ dir: './repo' });
await createBranch({ dir: './repo', name: 'feature/x' });
await checkoutBranch({ dir: './repo', ref: 'feature/x' });

await addPaths({ dir: './repo', paths: ['newfile.txt'] });
const { files } = await diffRepo({ dir: './repo', cached: true });
const history = await getLog({ dir: './repo', maxCount: 10 });

await createCommit({ dir: './repo', message: 'update files', all: true });
await shallowPush({ dir: './repo', remote: 'origin', ref: 'feature/x' });
```

## How it works

`isomorphic-git` lets you bring your own `http` client — an object with a `request()` method matching its `HttpClient` interface. This project implements that interface (`src/transport.js`) on top of an SSH exec channel instead of a real HTTP connection:

- `GET .../info/refs?service=git-upload-pack` → opens `git-upload-pack '<path>'` (or `git-receive-pack` for push) over SSH, reads the ref advertisement, and returns it as a synthesized smart-HTTP response (isomorphic-git expects a `# service=...` pkt-line that SSH never actually sends, so it's added back in).
- `POST .../git-upload-pack` (or `git-receive-pack`) → reuses the *same* SSH channel opened for discovery — exactly like real git does, since a single server-side process serves both steps — and streams the pack/result back.

The one hard constraint that shaped the design: isomorphic-git's ref-advertisement parser only stops at end-of-stream, not at the protocol's flush packet. Handing it a live, still-open SSH channel as that response body would deadlock forever (the server waiting for the client's next message, the client waiting for more bytes that will never come with the stream still open). So the discovery response is always a small, fully-buffered, finite value; only the actual pack/result response streams from the live channel.

### Source layout

| File | Responsibility |
| --- | --- |
| `src/pktline.js` | git pkt-line framing: reading a ref advertisement up to its flush packet, synthesizing the `# service=...` prefix |
| `src/channel.js` | `Channel` abstraction — a real `ssh2` exec channel, and a `child_process`-based one used for network-free tests |
| `src/known-hosts.js` | `~/.ssh/known_hosts` parsing and verification (hashed + plaintext entries), TOFU trust-and-append |
| `src/ssh-url.js` | Parses `ssh://` and scp-like git URLs |
| `src/ssh-connection.js` | Wires a parsed URL + auth options into a channel factory and host verifier (shared by clone and push) |
| `src/transport.js` | The isomorphic-git `HttpClient` shim described above |
| `src/ssh-http-client.js` | The transport shim repackaged as a reusable, general-purpose isomorphic-git `http` client for other Node programs (see "Using this SSH transport with your own isomorphic-git code") |
| `src/clone.js`, `src/push.js`, `src/branch.js`, `src/checkout.js`, `src/commit.js`, `src/add.js`, `src/diff.js`, `src/log.js` | Public library functions used by the CLI |
| `bin/jsgit.js` | CLI |
| `examples/` | Standalone scripts driving `isomorphic-git` + this SSH transport directly, without jsgit's own library wrappers |

## Testing

```sh
npm test
```

Runs entirely offline: `test/local.test.js` and `test/push.test.js` exercise the exact same transport code SSH would use, but over a local `git-upload-pack`/`git-receive-pack` child process (`createLocalChannelFactory`) against real git repositories, with results cross-checked against real git (`git fsck`, `git status`, `git log`). This isolates protocol bugs from SSH/auth bugs. `test/branch.test.js`, `test/checkout.test.js`, `test/commit.test.js`, `test/add.test.js`, `test/diff.test.js`, `test/log.test.js`, and `test/pktline.test.js`/`test/clone.test.js` cover branch/checkout/commit/add/diff/log semantics and pure parsing logic as unit tests — `test/diff.test.js` and `test/log.test.js` additionally cross-check output against real `git diff`/`git log`. `test/ssh-http-client.test.js` covers the reusable `http` client's GET/POST/auto-dispose state machine the same offline way, via an injectable connection factory (see that file's header comment).

`test/helpers.js` currently points at a specific local repo path for its "real git repo to clone from" fixture — see that file if you're running these tests outside the original development machine.

## Requirements

- Node.js >= 18
- An SSH key usable for the target host, loaded in your SSH agent (`SSH_AUTH_SOCK`) or passed via `--identity`
- The target host's key already in `~/.ssh/known_hosts`, or `--trust-new-hosts` to accept it on first use
