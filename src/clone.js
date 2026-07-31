// Public API: shallowClone(). Drives isomorphic-git's `clone` through the
// SSH transport shim, and repairs the one thing isomorphic-git's
// HTTP-shaped world model gets wrong for us afterwards: the remote URL it
// persists into .git/config.

import fs from 'node:fs';
import git from 'isomorphic-git';
import { createSshTransport } from './transport.js';
import { createSshConnection } from './ssh-connection.js';

export { parseSshUrl } from './ssh-url.js';

/**
 * @param {object} args
 * @param {string} args.url - an ssh:// or scp-like git remote URL
 * @param {string} args.dir - local directory to clone into
 * @param {number} [args.depth=1] - shallow clone depth
 * @param {string} [args.ref] - branch/ref to clone (defaults to remote HEAD)
 * @param {boolean} [args.singleBranch=true]
 * @param {boolean} [args.noCheckout=false]
 * @param {string} [args.remoteName='origin']
 * @param {string} [args.username] - overrides the URL's embedded user (default: url user, then 'git')
 * @param {string} [args.identityFile] - path to a private key file
 * @param {string} [args.passphrase]
 * @param {boolean} [args.trustNewHosts=false] - TOFU-accept hosts not already in known_hosts
 * @param {string} [args.knownHostsPath]
 * @param {(msg: string) => void} [args.onProgress]
 * @returns {Promise<{ dir: string, url: string }>}
 */
export async function shallowClone({
  url,
  dir,
  depth = 1,
  ref,
  singleBranch = true,
  noCheckout = false,
  remoteName = 'origin',
  username,
  identityFile,
  passphrase,
  trustNewHosts = false,
  knownHostsPath,
  onProgress,
}) {
  const { channelFactory, shimUrl, parsed } = await createSshConnection({
    url,
    username,
    identityFile,
    passphrase,
    trustNewHosts,
    knownHostsPath,
    onProgress,
  });
  const transport = createSshTransport({ channelFactory, repoPath: parsed.path });

  try {
    await git.clone({
      fs,
      http: transport,
      dir,
      url: shimUrl,
      remote: remoteName,
      ref,
      singleBranch,
      depth,
      noCheckout,
      onProgress: onProgress ? evt => onProgress(`${evt.phase} ${evt.loaded ?? ''}/${evt.total ?? ''}`) : undefined,
    });

    // Repair what clone() persisted: real `git fetch`/`git pull` afterwards
    // must see the actual ssh:// URL, not our http:// shim.
    await git.setConfig({ fs, dir, path: `remote.${remoteName}.url`, value: url });

    return { dir, url };
  } finally {
    await transport.dispose();
  }
}
