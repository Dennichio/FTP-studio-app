import { createServer, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';

/** A small real control/data server, intentionally only implementing commands exercised by these tests. */
export async function ftpFixture(options: { stallDownload?: boolean; controlNoDelay?: boolean; supportsMlst?: boolean; advertiseMlst?: boolean } = {}) {
  const files = new Map<string, Buffer>(); const advertisedSizes = new Map<string, number>(); const directories = new Set(['/']); const sockets = new Set<Socket>(); const passiveServers = new Set<Server>();
  const mlstResponses = new Map<string, string>(), commandCounts = new Map<string, number>();
  const chmodCalls: { path: string; mode: string }[] = [];
  const fixture = { port: 0, files, advertisedSizes, directories, chmodCalls, mlstResponses, commandCounts, downloadStarted: false, close: async () => { for (const socket of sockets) socket.destroy(); await Promise.all([...passiveServers].map(server => new Promise<void>(resolve => server.close(() => resolve())))); await new Promise<void>(resolve => server.close(() => resolve())); } };
  const server = createServer(control => {
    // Opt-in benchmark control: preserve the original fixture's TCP behavior by default.
    if (options.controlNoDelay) control.setNoDelay(true);
    sockets.add(control); control.on('close', () => sockets.delete(control)); control.on('error', () => undefined);
    let buffer = ''; let cwd = '/'; let renameFrom = ''; let restart = 0; let dataServer: Server | undefined; let dataSocket: Promise<Socket> | undefined;
    const reply = (line: string) => control.write(line + '\r\n');
    const path = (value: string) => posix.resolve(cwd, value);
    const passive = async (extended: boolean) => {
      if (dataServer) { dataServer.close(); passiveServers.delete(dataServer); }
      const passive = createServer(); dataServer = passive; passiveServers.add(passive);
      dataSocket = new Promise(resolve => passive.once('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined); resolve(socket); }));
      await new Promise<void>((resolve, reject) => {
        passive.once('error', reject);
        passive.listen(0, '127.0.0.1', () => { passive.removeListener('error', reject); resolve(); });
      }); const address = passive.address(); if (!address || typeof address === 'string') throw new Error('No passive address');
      reply(extended ? `229 Entering Extended Passive Mode (|||${address.port}|)` : `227 Entering Passive Mode (127,0,0,1,${address.port >> 8},${address.port & 255})`);
    };
    const data = async (action: (socket: Socket) => Promise<void>) => {
      if (!dataSocket) { reply('425 No passive connection'); return; }
      reply('150 Opening data connection'); const socket = await dataSocket; await action(socket);
      reply('226 Transfer complete'); dataSocket = undefined;
      if (dataServer) { dataServer.close(); passiveServers.delete(dataServer); dataServer = undefined; }
    };
    const command = async (line: string) => {
      const split = line.indexOf(' '); const verb = (split < 0 ? line : line.slice(0, split)).toUpperCase(); const arg = split < 0 ? '' : line.slice(split + 1);
      commandCounts.set(verb, (commandCounts.get(verb) ?? 0) + 1);
      switch (verb) {
        case 'USER': reply('331 Password needed'); break;
        case 'PASS': reply('230 Logged in'); break;
        case 'FEAT': control.write(`211-Features\r\n${options.advertiseMlst === false ? '' : ' MLST type*;size*;modify*;\r\n'} EPSV\r\n REST STREAM\r\n211 End\r\n`); break;
        case 'MLST': {
          if (!options.supportsMlst) { reply('502 Unsupported command'); break; }
          const target = path(arg), override = mlstResponses.get(target);
          if (override !== undefined) { reply(override); break; }
          const bytes = files.get(target), directory = directories.has(target);
          if (!bytes && !directory) { reply('550 Missing file'); break; }
          reply(`250-Listing\r\n type=${directory ? 'dir' : 'file'};size=${directory ? 0 : advertisedSizes.get(target) ?? bytes!.length};modify=20260101000000; ${target}\r\n250 End`); break;
        }
        case 'SYST': reply('215 UNIX Type: L8'); break;
        case 'TYPE': case 'STRU': case 'OPTS': reply('200 OK'); break;
        case 'PWD': reply(`257 "${cwd}"`); break;
        case 'CWD': if (directories.has(path(arg))) { cwd = path(arg); reply('250 Directory changed'); } else reply('550 Missing directory'); break;
        case 'CDUP': cwd = posix.dirname(cwd); reply('250 OK'); break;
        case 'EPSV': await passive(true); break;
        case 'PASV': await passive(false); break;
        case 'MLSD': case 'LIST': {
          const directory = path(arg || cwd); if (!directories.has(directory)) { reply('550 Missing directory'); break; }
          await data(async socket => { const lines: string[] = []; for (const [file, bytes] of files) if (posix.dirname(file) === directory) lines.push(`type=file;size=${advertisedSizes.get(file) ?? bytes.length};modify=20260101000000; ${posix.basename(file)}`); for (const folder of directories) if (folder !== '/' && posix.dirname(folder) === directory) lines.push(`type=dir;size=0;modify=20260101000000; ${posix.basename(folder)}`); await new Promise<void>(resolve => socket.end(lines.join('\r\n') + (lines.length ? '\r\n' : ''), resolve)); }); break;
        }
        case 'STOR': case 'APPE': {
          const target = path(arg); await data(async socket => { const chunks: Buffer[] = []; await new Promise<void>(resolve => { socket.on('data', chunk => chunks.push(chunk)); socket.once('end', () => { socket.end(); resolve(); }); }); files.set(target, Buffer.concat(verb === 'APPE' ? [files.get(target) ?? Buffer.alloc(0), ...chunks] : chunks)); }); break;
        }
        case 'REST': restart = Number(arg); reply('350 Restart accepted'); break;
        case 'RETR': {
          const bytes = files.get(path(arg)); if (!bytes) { reply('550 Missing file'); break; }
          fixture.downloadStarted = true;
          if (options.stallDownload) { reply('150 Opening stalled data connection'); break; }
          const start = restart; restart = 0; await data(async socket => { await new Promise<void>(resolve => socket.end(bytes.subarray(start), resolve)); }); break;
        }
        case 'RNFR': renameFrom = path(arg); reply('350 Rename destination needed'); break;
        case 'RNTO': {
          const target = path(arg), bytes = files.get(renameFrom);
          if (bytes) {
            files.set(target, bytes); files.delete(renameFrom);
            if (advertisedSizes.has(renameFrom)) { advertisedSizes.set(target, advertisedSizes.get(renameFrom)!); advertisedSizes.delete(renameFrom); }
            reply('250 Renamed');
          } else if (directories.has(renameFrom) && renameFrom !== '/' && !directories.has(target) && !files.has(target) && !target.startsWith(renameFrom + '/')) {
            const folders = [...directories].filter(item => item === renameFrom || item.startsWith(renameFrom + '/'));
            const children = [...files].filter(([item]) => item.startsWith(renameFrom + '/'));
            for (const item of folders) directories.delete(item);
            for (const item of folders) directories.add(target + item.slice(renameFrom.length));
            for (const [item, content] of children) {
              const moved = target + item.slice(renameFrom.length); files.delete(item); files.set(moved, content);
              if (advertisedSizes.has(item)) { advertisedSizes.set(moved, advertisedSizes.get(item)!); advertisedSizes.delete(item); }
            }
            reply('250 Renamed');
          } else reply('550 Missing source or invalid destination');
          renameFrom = ''; break;
        }
        case 'DELE': files.delete(path(arg)); reply('250 Deleted'); break;
        case 'MKD': directories.add(path(arg)); reply('257 Directory created'); break;
        case 'RMD': directories.delete(path(arg)); reply('250 Directory removed'); break;
        case 'SITE': { const match = /^CHMOD ([0-7]{3,4}) (.+)$/.exec(arg); if (!match) { reply('500 Invalid CHMOD'); break; } chmodCalls.push({ path: path(match[2]), mode: match[1] }); reply('200 Permissions changed'); break; }
        case 'SIZE': { const bytes = files.get(path(arg)); reply(bytes ? `213 ${bytes.length}` : '550 Missing file'); break; }
        case 'QUIT': reply('221 Goodbye'); control.end(); break;
        default: reply('502 Unsupported command');
      }
    };
    let chain = Promise.resolve();
    control.on('data', chunk => { buffer += chunk.toString(); let end: number; while ((end = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); chain = chain.then(() => command(line)).catch(() => { control.destroy(); }); } });
    reply('220 Local FTP fixture');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address'); fixture.port = address.port; return fixture;
}
