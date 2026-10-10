import { createHash, generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import type { Socket } from 'node:net';
import { posix } from 'node:path';

/** Real SSH transport and SFTP requests with test-only in-memory storage. */
export async function sftpFixture() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const key = utils.parseKey(privateKey); if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid fixture key');
  const fingerprint = 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const files = new Map<string, Buffer>(); const advertisedSizes = new Map<string, number>(); const specialModes = new Map<string, number>(); const directories = new Set(['/']); const links = new Set<string>();
  const connections = new Set<{ end(): void; _sock?: Socket }>(); let authentications = 0;
  const server = new Server({ hostKeys: [privateKey] }, connection => {
    connections.add(connection); connection.on('close', () => connections.delete(connection)); connection.on('error', () => undefined);
    connection.on('authentication', context => {
      authentications++;
      if (context.method === 'password' && context.password === 'test') context.accept();
      else if (context.method === 'publickey' && context.key.data.equals(key.getPublicSSH()) && (!context.signature || (context.blob && key.verify(context.blob, context.signature, context.hashAlgo) === true))) context.accept();
      else context.reject();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept(); session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(); let nextHandle = 0;
        const handles = new Map<string, { path: string; directory: boolean; listed?: boolean }>();
        const attrs = (path: string) => ({ mode: specialModes.get(path) ?? (links.has(path) ? 0o120777 : directories.has(path) ? 0o40755 : 0o100644), uid: 0, gid: 0, size: advertisedSizes.get(path) ?? files.get(path)?.length ?? 0, atime: 1767225600, mtime: 1767225600 });
        const exists = (path: string) => files.has(path) || directories.has(path) || links.has(path) || specialModes.has(path);
        const getHandle = (handle: Buffer) => handles.get(handle.toString());
        const stat = (request: number, path: string) => exists(path) ? sftp.attrs(request, attrs(path)) : sftp.status(request, 2);
        sftp.on('LSTAT', stat); sftp.on('STAT', stat);
        sftp.on('FSTAT', (request, handle) => { const h = getHandle(handle); if (h) stat(request, h.path); else sftp.status(request, 4); });
        sftp.on('REALPATH', (request, path) => sftp.name(request, [{ filename: posix.resolve('/', path), longname: path, attrs: attrs(path) }]));
        const opened = (request: number, path: string, directory: boolean) => { const id = String(++nextHandle); handles.set(id, { path, directory }); sftp.handle(request, Buffer.from(id)); };
        sftp.on('OPENDIR', (request, path) => directories.has(path) ? opened(request, path, true) : sftp.status(request, 2));
        sftp.on('READDIR', (request, handle) => {
          const h = getHandle(handle); if (!h) { sftp.status(request, 4); return; }
          if (h.listed) { sftp.status(request, 1); return; } h.listed = true;
          const entries = [...new Set([...files.keys(), ...directories, ...links, ...specialModes.keys()])].filter(path => path !== '/' && posix.dirname(path) === h.path).map(path => ({ filename: posix.basename(path), longname: posix.basename(path), attrs: attrs(path) }));
          if (entries.length) sftp.name(request, entries); else sftp.status(request, 1);
        });
        sftp.on('OPEN', (request, path, flags) => { if ((flags & 8) && !files.has(path)) files.set(path, Buffer.alloc(0)); if ((flags & 16) && files.has(path)) files.set(path, Buffer.alloc(0)); if (!files.has(path)) sftp.status(request, 2); else opened(request, path, false); });
        sftp.on('READ', (request, handle, offset, length) => { const h = getHandle(handle); const bytes = h && files.get(h.path); if (!bytes) sftp.status(request, 4); else if (offset >= bytes.length) sftp.status(request, 1); else sftp.data(request, bytes.subarray(offset, offset + length)); });
        sftp.on('WRITE', (request, handle, offset, chunk) => { const h = getHandle(handle); if (!h) { sftp.status(request, 4); return; } const old = files.get(h.path) ?? Buffer.alloc(0); const bytes = Buffer.alloc(Math.max(old.length, offset + chunk.length)); old.copy(bytes); chunk.copy(bytes, offset); files.set(h.path, bytes); sftp.status(request, 0); });
        sftp.on('CLOSE', (request, handle) => { handles.delete(handle.toString()); sftp.status(request, 0); });
        sftp.on('MKDIR', (request, path) => { directories.add(path); sftp.status(request, 0); });
        sftp.on('RMDIR', (request, path) => { directories.delete(path); sftp.status(request, 0); });
        sftp.on('REMOVE', (request, path) => { files.delete(path); sftp.status(request, 0); });
        sftp.on('RENAME', (request, from, to) => { const bytes = files.get(from); if (!bytes) sftp.status(request, 2); else { files.set(to, bytes); files.delete(from); sftp.status(request, 0); } });
        sftp.on('SETSTAT', (request) => sftp.status(request, 0));
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No SSH address');
  return { port: address.port, fingerprint, userPrivateKey: privateKey, files, advertisedSizes, specialModes, directories, links, get authentications() { return authentications; }, close: async () => { for (const connection of connections) { connection.end(); connection._sock?.destroy(); } await new Promise<void>(resolve => server.close(() => resolve())); } };
}
