# Examples

Standalone scripts showing how to drive `isomorphic-git` directly against this project's SSH transport (`src/ssh-http-client.js`), without going through the `jsgit` CLI or its own `clone()`/`push()`/etc. library wrappers.

Run from the repository root (they import from `../src/...`):

```sh
node examples/sparse-clone-branch-commit-push.js <ssh-url> [dir] [sparse-path...]
```

## `sparse-clone-branch-commit-push.js`

A full workflow in one script, using only plain `isomorphic-git` calls plus `createSshHttpClient()`:

1. **Sparse clone** — shallow-clones with `noCheckout: true`, then checks out only the given paths via `git.checkout({filepaths})`. See the script's own header comment for what "sparse" does and doesn't mean here (isomorphic-git has no real sparse-checkout/cone-mode support).
2. **Switch to a new branch** — `git.branch()` + `git.checkout()`.
3. **Add a file and commit it** — `git.add()` + `git.commit()`.
4. **Push the new branch** — `git.push()`, reusing the same `http`/`url` pair the clone used; a fresh SSH connection is opened and closed automatically for the push, same as for the clone.

```sh
node examples/sparse-clone-branch-commit-push.js git@github.com:org/repo.git ./example-repo README.md docs
```

Requires an SSH key usable for the target host, loaded in your SSH agent or resolvable via the default `~/.ssh/id_rsa`, and the host already present in `~/.ssh/known_hosts` (see the main README's "Host key verification" section). The script pushes a new branch named `jsgit-example-<timestamp>` and prints the command to delete it again when you're done experimenting.
