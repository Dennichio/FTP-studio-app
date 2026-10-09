import { createServer as netServer, type Socket } from 'node:net';
import { createServer as tlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';

/** This fixture deliberately uses an untrusted certificate; its private key is public test data. */
export async function untrustedTlsFixture(implicit: boolean) {
  const [key, cert] = await Promise.all([readFile(new URL('./untrusted-tls-key.pem', import.meta.url)), readFile(new URL('./untrusted-tls-cert.pem', import.meta.url))]);
  const sockets = new Set<Socket>(); let receivedCredentials = false;
  const observe = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined); };
  const server = implicit ? tlsServer({ key, cert }, socket => { socket.write('220 TLS fixture\r\n'); socket.on('data', () => { receivedCredentials = true; }); }) : netServer(socket => {
    socket.write('220 Explicit TLS fixture\r\n'); let buffer = '';
    const command = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (/^(USER|PASS) /i.test(buffer)) receivedCredentials = true;
      if (buffer.includes('AUTH TLS\r\n')) {
        socket.removeListener('data', command);
        socket.write('234 Begin TLS\r\n', () => { const secure = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key, cert }) }); observe(secure); });
      }
    };
    socket.on('data', command);
  });
  server.on('connection', observe); server.on('tlsClientError', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TLS address');
  return { port: address.port, get receivedCredentials() { return receivedCredentials; }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
