// Compatibility declarations for the v12 API used by FTP Studio. The
// installed @types package describes v9 and cannot augment its export= class.
// Stream option directions match src/index.js in ssh2-sftp-client: get reads
// through ssh2 and writes locally; put reads locally and writes through ssh2.
declare module 'ssh2-sftp-client' {
  import type { Client, ConnectConfig, ReadStreamOptions, SFTPWrapper, WriteStreamOptions } from 'ssh2';
  import type { ReadStreamOptions as LocalReadOptions, WriteStreamOptions as LocalWriteOptions } from 'node:fs';

  class SftpClient {
    constructor(name?: string);
    readonly client: Client;
    connect(options: ConnectConfig & { retries?: number }): Promise<SFTPWrapper>;
    list(remotePath: string): Promise<SftpClient.FileInfo[]>;
    lstat(remotePath: string): Promise<SftpClient.FileStats>;
    stat(remotePath: string): Promise<SftpClient.FileStats>;
    mkdir(remotePath: string, recursive?: boolean): Promise<string>;
    rmdir(remotePath: string, recursive?: boolean): Promise<string>;
    delete(remotePath: string, noErrorOK?: boolean): Promise<string>;
    rename(source: string, destination: string): Promise<string>;
    chmod(remotePath: string, mode: string | number): Promise<string>;
    put(
      source: string | Buffer | NodeJS.ReadableStream,
      remotePath: string,
      options?: { readStreamOptions?: LocalReadOptions; writeStreamOptions?: WriteStreamOptions },
    ): Promise<string>;
    get(
      remotePath: string,
      destination?: string | NodeJS.WritableStream,
      options?: { readStreamOptions?: ReadStreamOptions; writeStreamOptions?: LocalWriteOptions },
    ): Promise<string | Buffer | NodeJS.WritableStream>;
    end(): Promise<boolean>;
  }

  namespace SftpClient {
    interface FileInfo {
      longname?: string;
      // v12 derives this from the server's longname, including special types.
      type: string;
      name: string;
      size: number;
      modifyTime: number;
      accessTime: number;
      rights: { user: string; group: string; other: string };
      owner: number;
      group: number;
    }
    interface FileStats {
      mode: number;
      uid: number;
      gid: number;
      size: number;
      accessTime: number;
      modifyTime: number;
      isDirectory: boolean;
      isFile: boolean;
      isBlockDevice: boolean;
      isCharacterDevice: boolean;
      isSymbolicLink: boolean;
      isFIFO: boolean;
      isSocket: boolean;
    }
  }
  export = SftpClient;
}
