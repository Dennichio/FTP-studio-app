import path from 'node:path';
import type { ConnectionProfile } from '../shared/contracts';
/** Authentication binding excludes workspace roots and display-only profile fields. */
export function credentialIdentity(profile: ConnectionProfile): string {
  return JSON.stringify([profile.protocol, profile.host.trim().toLowerCase(), profile.port, profile.username,
    profile.protocol === 'sftp' ? (profile.hostKeySha256 ?? '').replace(/^SHA256:/i, '').replace(/=+$/, '') : null,
    profile.protocol === 'sftp' ? profile.privateKeyPath || null : null]);
}
/** Exact credential-free target binding, independent of a mutable profile id/name. */
export function endpointIdentity(profile: ConnectionProfile): string {
  const localRoot = path.resolve(profile.localRoot);
  return JSON.stringify([profile.protocol, profile.host.trim().toLowerCase(), profile.port, profile.username,
    profile.protocol === 'sftp' ? (profile.hostKeySha256 ?? '').replace(/^SHA256:/i, '').replace(/=+$/, '') : null,
    path.posix.normalize(profile.remoteRoot || '/').replace(/\/$/, '') || '/', process.platform === 'win32' ? localRoot.toLowerCase() : localRoot]);
}
