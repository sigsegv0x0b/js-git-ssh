// Public API: shallowPush(). Symmetric to clone.js/fetch, but over
// git-receive-pack: same SSH connection setup (src/ssh-connection.js), same
// transport shim, just a different service name and a different
// isomorphic-git entry point.

import fs from 'node:fs';
import git from 'isomorphic-git';
import { createSshTransport } from './transport.js';
import { createSshConnection } from './ssh-connection.js';

/**
 * @param {object} args
 * @param {string} args.dir - local repo directory (must already have `remote.<remote>.url` configured, or pass `url`)
 * @param {string} [args.remote='origin']
 * @param {string} [args.ref] - local branch/ref to push (default: current branch)
 * @param {string} [args.remoteRef] - remote ref name to update (default: same name as `ref`)
 * @param {boolean} [args.force=false] - allow non-fast-forward updates
 * @param {boolean} [args.delete=false] - delete `remoteRef` on the remote instead of updating it
 * @param {string} [args.url] - explicit ssh:// URL, overriding `remote.<remote>.url` from the repo config
 * @param {string} [args.username]
 * @param {string} [args.identityFile]
 * @param {string} [args.passphrase]
 * @param {boolean} [args.trustNewHosts=false]
 * @param {string} [args.knownHostsPath]
 * @param {(msg: string) => void} [args.onProgress]
 * @param {(msg: string) => void} [args.onMessage] - server-side messages (e.g. GitHub's "remote: ..." lines)
 * @returns {Promise<import('isomorphic-git').PushResult>}
 */
export async function shallowPush({
  dir,
  remote = 'origin',
  ref,
  remoteRef,
  force = false,
  delete: del = false,
  url: explicitUrl,
  username,
  identityFile,
  passphrase,
  trustNewHosts = false,
  knownHostsPath,
  onProgress,
  onMessage,
}) {
  const sourceUrl = explicitUrl || (await git.getConfig({ fs, dir, path: `remote.${remote}.url` }));
  if (!sourceUrl) {
    throw new Error(`No URL configured for remote '${remote}' in ${dir}, and no explicit url was given.`);
  }

  const { channelFactory, shimUrl, parsed } = await createSshConnection({
    url: sourceUrl,
    username,
    identityFile,
    passphrase,
    trustNewHosts,
    knownHostsPath,
    onProgress,
  });
  // isomorphic-git's push, like fetch, dispatches on the URL's scheme via
  // GitRemoteManager.getRemoteHelperFor() and only accepts http(s) -- so we
  // give it the same http:// shim URL used for clone, not the real ssh:// one.
  const transport = createSshTransport({ channelFactory, repoPath: parsed.path, service: 'git-receive-pack' });

  try {
    return await git.push({
      fs,
      http: transport,
      dir,
      remote,
      ref,
      remoteRef,
      force,
      delete: del,
      url: shimUrl,
      onProgress: onProgress ? evt => onProgress(`${evt.phase} ${evt.loaded ?? ''}/${evt.total ?? ''}`) : undefined,
      onMessage,
    });
  } catch (err) {
    throw rewriteError(err);
  } finally {
    await transport.dispose();
  }
}

/** Turns isomorphic-git's push error shapes into one clear, CLI-friendly message. */
function rewriteError(err) {
  if (err && err.code === 'PushRejectedError') {
    return new Error(`${err.message.replace('Use "force: true" to override.', 'Use --force to override.')}`);
  }
  if (err && err.code === 'GitPushError' && err.data && err.data.result) {
    const details = Object.entries(err.data.result.refs || {})
      .filter(([, v]) => !v.ok)
      .map(([refName, v]) => `  - ${refName}: ${v.error}`)
      .join('\n');
    return new Error(`push rejected by remote:\n${details || err.message}`);
  }
  return err;
}
