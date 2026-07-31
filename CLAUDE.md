# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pure-JavaScript git client for Node (no native modules, no `git` binary) that clones, branches, and pushes over SSH. `isomorphic-git` only ships HTTP(S) transports, so this project's core contribution is an SSH transport: an object matching isomorphic-git's `HttpClient` interface, backed by an `ssh2` exec channel instead of a real HTTP connection. See README.md for the user-facing CLI/API surface — this file covers what you need to safely modify the transport layer itself.

## Commands

```sh
npm install          # installs with --omit=optional via .npmrc, so ssh2's optional
                      # native helpers are never built -- do not remove that .npmrc setting
npm test              # runs test/**/*.test.js (node --test), fully offline
node --test test/push.test.js         # run a single test file
node --test test/push.test.js --test-name-pattern "non-fast-forward"   # run one test by name
node bin/jsgit.js <command> --help    # CLI usage per subcommand
```

There is no build step and no linter configured. `node --test "test/**/*.test.js"` (the glob, quoted) is required on this Node version — `node --test test/` (bare directory) does not discover files.

## Architecture

### The transport shim is the load-bearing piece

`src/transport.js` implements isomorphic-git's `http.request()` contract on top of a `Channel` (see `src/channel.js`). isomorphic-git's fetch and push flows each make exactly two calls, symmetric in shape and handled identically here regardless of service:

- `GET .../info/refs?service=<service>` → opens `<service> '<repoPath>'` over the channel, reads the ref advertisement, returns a synthesized response.
- `POST .../<service>` → **reuses the same channel** opened for discovery (the transport is stateful across these two calls via a `pending` closure variable) and streams the pack/result back.

`<service>` is `git-upload-pack` for clone/fetch or `git-receive-pack` for push — the transport code itself has no service-specific branches; everything (content-type headers, the command string, capability advertisement) is parameterized by it.

**The one invariant that must never be violated:** isomorphic-git's ref-advertisement parser (`parseRefsAdResponse`) stops reading only at end-of-stream, not at the protocol's flush packet. If the GET response body were the live, still-open channel, this deadlocks permanently — the server is blocked waiting for the client's next message, the client is blocked waiting for bytes that will never come while the stream stays open. So:
- The GET/discovery response body is **always** a small, fully-buffered, finite value (`readAdvertisement()` in `src/pktline.js` reads up to and including the flush packet, then stops).
- Only the POST/result response is allowed to stream from the live channel.

If you touch `transport.js`, preserve this split. It is the actual reason the SSH transport works at all instead of hanging.

Real SSH `git-upload-pack`/`git-receive-pack` invocations do not send the `# service=...` pkt-line that smart-HTTP responses include and that isomorphic-git's parser requires — `src/pktline.js`'s `serviceAdvertisementPrefix()` synthesizes it. This was confirmed empirically against real git server processes, not assumed from docs.

### Channel abstraction enables offline testing

`src/channel.js` defines a `Channel` interface (`stdout`, `write()`, `end()`, `waitForExit()`, `close()`) with two implementations:
- `createSshChannelFactory` — a real `ssh2` exec channel.
- `createLocalChannelFactory` — a local `child_process` running the same git commands directly, no network or keys.

Because `transport.js` only depends on the `Channel` interface, the entire wire protocol (pkt-line framing, service dispatch, capability negotiation, error surfacing) is tested against real `git-upload-pack`/`git-receive-pack` processes without ever touching SSH. `test/local.test.js` and `test/push.test.js` use `createLocalChannelFactory` this way; only the actual SSH connection/auth/host-key path goes untested by the offline suite (exercised instead via live manual runs against a reachable host).

`waitForExit()` resolves on the channel's `'close'` event, not `'exit'` — `'exit'` depends on the remote sending an SSH exit-status message, which isn't guaranteed on all servers, and gating on both events risks the transport hanging forever on an otherwise-successful operation after the full payload has already been received. `info.code` can legitimately be `null` as a result; only a definitely-nonzero code should be treated as failure.

### URL/connection plumbing is shared, not duplicated, between clone and push

`src/ssh-url.js` (`parseSshUrl`, `buildShimUrl`) and `src/ssh-connection.js` (`createSshConnection`) are used identically by `src/clone.js` and `src/push.js` — the SSH connection setup doesn't care which git service will run over it. If you need to change how URLs are parsed or how host verification/auth is wired up, change it once in these shared modules rather than in both `clone.js` and `push.js`.

isomorphic-git's remote dispatch (`GitRemoteManager.getRemoteHelperFor`) only accepts `http`/`https` URL schemes — it throws for anything else, including `ssh://`, regardless of what custom `http` client you pass. This is why both `clone.js` and `push.js` give isomorphic-git a synthetic `http://ssh-shim/<path>` URL (`buildShimUrl`) instead of the real `ssh://` address; the custom `http` object supplies the actual transport, the URL only needs a scheme isomorphic-git's dispatcher will accept. Real git tooling still needs the real address, though: `clone.js` rewrites `remote.<name>.url` back to the original `ssh://`/scp-style URL in `.git/config` immediately after `git.clone()` returns, since isomorphic-git would otherwise persist the shim URL. `push.js` correspondingly *reads* `remote.<name>.url` from config to figure out where to connect (unless `--url`/`url:` is given explicitly), so it depends on that rewrite having happened.

No `@` is allowed in the shim URL: isomorphic-git's `extractAuthFromUrl()` treats anything before an `@` in an `http(s)` URL as embedded basic-auth credentials and strips it.

### The reusable `http` client (`src/ssh-http-client.js`) auto-closes on the POST response, which some isomorphic-git calls never send

`createSshHttpClient()` repackages `transport.js` + `ssh-connection.js` as a generic isomorphic-git `http` client for external callers, with a connection lifecycle deliberately different from `clone.js`/`push.js`'s own (single connection, caller-managed `try/finally` dispose): here, a fresh SSH connection is opened per GET and closed automatically once the following POST's response body has been fully consumed (`disposeAfterDrain` wraps that body in a `finally`).

That auto-close is anchored to the POST response specifically because that's the only point with a real "this operation is over" signal. isomorphic-git's discover-only entry points (`git.listServerRefs`, `getRemoteInfo`/`getRemoteInfo2`) call `GitRemoteHTTP.discover()` and return — GET only, no POST ever follows — so there is no hook to auto-close on. **Confirmed empirically, not assumed:** a `listServerRefs()` call against a real client left the Node process hanging indefinitely (had to be `timeout`-killed) before this was handled; after adding the fix below, the same script exits with code 0. Don't "simplify away" the explicit `dispose()` method thinking the POST hook covers everything — it doesn't, and this is the case that proves it.

Two mechanisms cover it, both live in `handleGet`/the returned client object:
- Every GET disposes whatever connection is still `current` from a *previous* GET before opening its own — so two discover-only calls in a row (or a discover-only call followed by a clone/fetch/push) don't accumulate open connections.
- The client exposes `dispose()` (just `disposeCurrent()`) as the escape hatch for the *last* operation on a client, when nothing later will trigger the "next GET" cleanup. Idempotent — safe to call more than once or when nothing is open.

This also means the client is **not** safe for concurrent operations sharing one instance, more sharply than a typical "single in-flight slot" caveat: since a fresh GET actively disposes whatever's `current`, a second operation's GET will tear down a first operation's still-in-flight connection out from under it, and the first operation's later POST then runs against the second operation's transport instead. This is corruption, not just an odd interleave — a separate `createSshHttpClient()` call is required per concurrent operation.

`handlePost` also disposes on a request-level failure (not just after a successful drain) — without that, a POST that throws before ever returning a response (e.g. the channel dies mid-exec) would leave `current` cleared but the transport's connection never closed, an easy leak to reintroduce if this function is refactored.

### Host key verification (`src/known-hosts.js`)

Parses `~/.ssh/known_hosts` (hashed `|1|salt|hash` entries and plaintext, including the `[host]:port` bracketed form for non-default ports) and wires into `ssh2`'s `hostVerifier`. Trust-on-first-use (`--trust-new-hosts`) only applies to genuinely unknown hosts. A host that's already known but presents a **different** key is always a hard failure — that's the actual attack TOFU is meant to catch, so `--trust-new-hosts` must never be allowed to paper over a key mismatch. Preserve that asymmetry if you touch this file.

### Branch semantics (`src/branch.js`)

Deliberately mirrors real `git branch`, including that creating/renaming a branch never touches the working tree (isomorphic-git's `git.branch({checkout: true})` only repoints the `HEAD` symref). `deleteBranch`'s safety check (refuse to delete an unmerged branch without force) is implemented here, not by isomorphic-git — `git.deleteBranch()` has no such check built in. The merge check treats "cannot determine" (e.g. a shallow clone's history is truncated before a common ancestor would be found) as "not merged," matching real git's fail-safe default of requiring force in ambiguous cases.

Switching branches (moving HEAD *and* rewriting the working tree) is deliberately a separate module, `src/checkout.js`, built on isomorphic-git's `git.checkout()` — the one isomorphic-git API that actually touches files. `checkoutBranch({newBranch, ...})` composes `createBranch()` (ref creation) with `git.checkout()` (switch) rather than duplicating branch-creation logic.

### Commit semantics (`src/commit.js`)

`createCommit()` operates on the current index only, matching real git's separation of `add` (stage) from `commit` (record); new files are staged with `jsgit add` (`src/add.js`). The one staging isomorphic-git doesn't do that this module implements itself is `-a`/`all`: it walks `git.statusMatrix()` and stages (`git.add()`/`git.remove()`) only rows where `HEAD !== 0` (i.e. already-tracked), mirroring real `git commit -a`'s refusal to pick up new untracked files. `disallowEmpty` is inverted from isomorphic-git's own default (`false`) to `true` unless `--allow-empty` is passed, since isomorphic-git happily creates empty commits by default and real git does not.

### Add semantics (`src/add.js`)

A thin wrapper over `git.add()`, hardened against two gaps isomorphic-git itself leaves open:
- **No containment check.** `git.add({filepath: '../outside.txt'})` (or an absolute path outside `dir`) is not rejected by isomorphic-git — it silently writes a bogus index entry pointing outside the repo. `toRepoRelativePath()` resolves every input path against `dir` and throws if the result isn't inside it.
- **`path.join`, not `path.resolve`, semantics.** isomorphic-git joins `filepath` onto `dir` with plain `path.join`, which does *not* special-case an absolute second argument the way `path.resolve` does — handing it an absolute path (even one legitimately inside the repo) computes a doubled/wrong path (`join('/repo', '/repo/file.txt')` → `/repo/repo/file.txt`). Every path is normalized to a `dir`-relative string before it ever reaches `git.add()`. `test/add.test.js` has a regression test for this specific case.

Everything else (directory recursion, `.gitignore` handling, `--force`, symlink content) is already correct in isomorphic-git's own `git.add()` and isn't reimplemented here.

### Diff semantics (`src/diff.js`)

Neither isomorphic-git nor this project has a content-diffing primitive (`statusMatrix()` only ever compares oids, never bytes; isomorphic-git's own `diff3` dependency is merge-only). `diffTrees()` does the tree-walking itself with `git.walk()`/`TREE()`/`WORKDIR()`/`STAGE()` — the same primitives `statusMatrix()` is built on — and hands the actual line-diffing (Myers algorithm) to the `diff` npm package (jsdiff), confirmed pure JS with zero runtime dependencies.

Things that will bite you if you touch this file:
- **`.git/` pruning order matters.** The ignore-check (`git.isIgnored()`) must run *before* any tree-type check in `walk()`'s `map` callback, and must `return null` (not `undefined`) to prune descent — `null` stops `walk()` from recursing into a directory's children, `undefined` only skips that one entry. Getting the order wrong lets `.git/**` leak into a workdir-inclusive diff as a pile of spurious "added" files, because `walk()` does zero gitignore filtering on its own and a literal `.git` path component is always ignored (`GitIgnoreManager.isIgnored` hardcodes this). This mirrors `statusMatrix()`'s own internal guard exactly.
- **`WORKDIR()` must be `{refresh: false}`.** The default (`refresh: true`) writes back to `.git/index` to refresh its stat cache — never acceptable for a read-only diff operation.
- **`STAGE().content()` is always `undefined`.** The index walker never returns bytes, only oids — `readEntryBytes()` falls back to `readBlob({fs, dir, oid})` whenever an entry came from `STAGE()`.
- **jsdiff's `headerOptions` knob is a false lead.** `headerOptions: {includeIndex: false, includeUnderline: false}` on `createTwoFilesPatch` looks like it should strip only jsdiff's own `===...===`/`Index:` decoration, but empirically (tested directly against `diff@9.0.0`) it also strips the `---`/`+++` lines you actually want. The working approach is `structuredPatch()` (raw hunks) + `formatPatch()` (adds correct `-0,0`/`+0,0` handling for new/deleted files) with no `headerOptions`, then stripping only the literal `===...===` line via a `/^=+$/` regex check on the first line.
- **Context default mismatch.** jsdiff's own default context is 4 lines; git's is 3. Always pass `{context: 3}` explicitly (or whatever `-U`/`--context` was given) — never rely on jsdiff's default.
- **Cosmetic-only differences from real `git diff`**, not bugs: jsdiff's `@@` hunk headers never include git's "nearest preceding function/section heading" heuristic (e.g. `@@ ... @@ function foo()`), and jsdiff writes `@@ -1,1 +1,1 @@` where git collapses a single-line range to `@@ -1 +1 @@`. `test/diff.test.js`'s cross-check helper (`hunkContentLines`) works around both by comparing only content lines, never `@@`/header lines, against real git's output.

`bin/jsgit.js`'s `cmdDiff` also has one CLI-parsing gotcha worth knowing: Node's `parseArgs` silently swallows a literal `--` token and flattens everything after it into the same `positionals` array, with no way to recover the split point from `parseArgs`'s own output (verified empirically). The `--` must be found (`rest.indexOf('--')`) and the args array pre-split *before* calling `parseArgs`, not after. `cmdLog` reuses the same pre-split pattern for its own `-- <path>`.

### Log semantics (`src/log.js`)

A thin wrapper over isomorphic-git's own `git.log()`, which already does the real work (walking commit parents, an optional single-path history, a commit-count cutoff) — there's very little for this module to add, unlike `diff`/`add`. Two things worth knowing if you touch it:

- **`filepath` is a single path, not a pathspec list.** isomorphic-git's `git.log({filepath})` only accepts one path and has no concept of multiple pathspecs — so `jsgit log -- <path>...` rejects more than one path at the CLI layer rather than silently only honoring the first.
- **`depth` means max-commit-count here, not shallow-clone depth.** Same parameter name as `clone`'s `--depth`, completely different meaning — don't conflate the two when reading isomorphic-git's source. Worse, isomorphic-git's own `depth: 0` does **not** mean "zero commits": `_log`'s walk loop unconditionally pushes the starting commit before it ever checks the depth cutoff, so `depth: 0` behaves exactly like "no limit" (confirmed empirically). Real git's `-n 0` prints nothing, so `getLog()` special-cases `maxCount === 0` to return `[]` directly rather than ever calling `git.log()` with it. `bin/jsgit.js`'s `parseMaxCount()` also guards the CLI input itself: a bare `values['max-count'] ? parseInt(...) : undefined` check would let `-n 0` fall through to `undefined` (falsy) and silently mean "no limit" instead of "none", and would let `-n abc` become `depth: NaN` (which also never satisfies the walk's `=== depth` check, so it walks everything) — both wrong in the same direction, both fixed by parsing first and validating the result is a non-negative integer.
- **No `--follow` (rename-following).** isomorphic-git's own `follow` support was tested directly against real `git log --follow` on both a 3-commit rename chain (create → modify → rename) and a 2-commit chain (create → rename, no intervening content change). The 3-commit case matched real git exactly; the 2-commit case silently dropped the origin (`create`) commit. Root cause, traced directly in isomorphic-git's `_log`: when `resolveFileIdInTree` detects the rename, the code pushes the *previous* iteration's commit and switches to tracking the old filename, but then unconditionally sets `isOk = false` at the end of that same catch block — so if the old filename never resolves again (because that rename commit was also the file's origin), the "push the last known commit before giving up" fallback that would otherwise catch it never fires. This is silent — no error, no signal, just a shorter list than reality — which is worse than not offering the feature, so `--follow` isn't exposed. Matches this project's existing stance on rename detection generally (see `src/diff.js`'s scope note). Don't re-add it without first fixing (or working around) that upstream bug.
- The default (non-`--oneline`) and `--oneline` output formats in `bin/jsgit.js` (`formatCommitEntry`/`formatCommitOneline`) were verified byte-for-byte against real `git log`/`git log --oneline`, including the `Merge: <parent1> <parent2>` line for merge commits and the detail that every line of the message body — including blank lines within it — is indented with exactly 4 spaces (a blank message line becomes `"    "`, not `""`). The date format (`formatCommitDate`) reproduces git's asctime-style default (`Fri May 15 09:24:04 2026 -0700`) computed in the commit's own recorded timezone, not the reader's.

## Testing philosophy

Tests are written to independently verify against real git wherever possible, not just against isomorphic-git's own behavior — e.g. `git fsck`/`git status` on the result of a clone or push, diffed against a real `git clone`/`git push` baseline rather than asserted to be empty outright (some source repos have pre-existing dangling objects; asserting literal emptiness produces false failures unrelated to this code). When adding tests for new protocol behavior, prefer this pattern: exercise the real transport code via `createLocalChannelFactory` against a real (possibly scratch/bare) git repository, then cross-check the result with the actual `git` binary.
