export type Protocol = 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp';
export type ComparisonStatus = 'local-newer' | 'remote-newer' | 'local-only' | 'remote-only' | 'probably-identical' | 'conflict' | 'uncertain';
export interface FileEntry {
  name: string; path: string; relativePath?: string; kind: 'file' | 'directory' | 'symlink';
  size: number; modifiedAt: number | null; precisionMs?: number; permissions?: string;
  comparison?: ComparisonStatus; checksum?: string;
}
export interface ConnectionProfile {
  id: string; name: string; group?: string; host: string; port: number; protocol: Protocol;
  username: string; localRoot: string; remoteRoot: string; timeoutMs: number;
  connectionLimit: number; parallelTransfers: number; autoReconnect: boolean;
  privateKeyPath?: string; hostKeySha256?: string; passive?: boolean;
}
export interface Credentials { password?: string; passphrase?: string; }
export interface ConnectionState { id: string; profile: ConnectionProfile; connected: boolean; error?: string; endpointKey?: string; }
export interface Bookmark { id: string; name: string; localPath: string; remotePath?: string; profileId?: string; }
export interface FilterRule {
  id: string; field: 'name' | 'extension' | 'path' | 'directory' | 'size' | 'modified';
  operator: 'glob' | 'regex' | 'equals' | 'gt' | 'lt'; value: string; action: 'include' | 'exclude';
}
export interface FilterSet { display: FilterRule[]; transfer: FilterRule[]; sync: FilterRule[]; }
export interface PublishEnvironment { id: string; name: string; profileId: string; remoteRoot: string; production: boolean; }
export interface Project {
  id: string; name: string; localRoot: string; profileId?: string; remoteRoot: string;
  filters: FilterSet; environments: PublishEnvironment[]; previewUrl?: string;
  bookmarks: Bookmark[]; openFiles?: string[];
}
export interface AppSettings {
  theme: 'dark' | 'light' | 'system'; showHidden: boolean; syncNavigation: boolean;
  editorFontSize: number; wordWrap: boolean; autoUpload: boolean;
  layout?: { browserHeight?: number; queueHeight?: number; editorMode?: string; browserHidden?: boolean; queueHidden?: boolean; queueExpanded?: boolean; maximizedPanel?: 'browser' | 'editor' | 'queue' | null };
  lastProjectId?: string;
}
export interface Snippet { id: string; name: string; language: string; body: string; }
export interface FileSnapshot { size: number; modifiedAt: number | null; checksum?: string; }
export interface DocumentData {
  id: string; path: string; name: string; content: string; encoding: 'utf8'; eol: 'LF' | 'CRLF';
  remote?: { connectionId: string; path: string; original: FileSnapshot; endpointKey?: string };
  original: FileSnapshot; recovery?: boolean;
}
export interface SearchQuery { text: string; regex: boolean; caseSensitive: boolean; glob?: string; }
export interface SearchResult { path: string; line: number; column: number; text: string; length: number; }
export interface ReplacementPreview { path: string; before: string; after: string; checksum: string; count: number; }
export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'conflict';
export interface TransferRequest {
  connectionId: string; direction: 'upload' | 'download'; localPath: string; remotePath: string;
  priority?: number; expectedRemote?: FileSnapshot | null; expectedLocal?: FileSnapshot | null;
  allowSensitive?: boolean; projectId?: string; expectedEndpoint?: string;
}
export interface TransferJob extends TransferRequest {
  id: string; status: TransferStatus; size: number; transferred: number; speed: number;
  remainingSeconds: number | null; attempts: number; error?: string; createdAt: number;
  sourceSnapshot?: FileSnapshot; verifiedRemote?: FileSnapshot; verifiedLocal?: FileSnapshot;
}
export interface TransferProgress { transferred: number; total: number; }
export interface LogEntry { id: string; time: number; level: 'info' | 'warning' | 'error' | 'debug'; message: string; connectionId?: string; }
export interface ManifestEntry { relativePath: string; local: FileSnapshot; remote: FileSnapshot; publishedAt: number; }
export interface PublishItem {
  relativePath: string; localPath: string; remotePath: string; action: 'upload' | 'download' | 'conflict' | 'skip';
  reason: string; selected: boolean; local?: FileSnapshot; remote?: FileSnapshot; dependency?: boolean; excluded?: boolean;
}
export interface PublishPlan { id: string; projectId: string; connectionId: string; environmentId?: string; production: boolean; items: PublishItem[]; createdAt: number; }
export interface BootstrapData { profiles: ConnectionProfile[]; projects: Project[]; settings: AppSettings; snippets: Snippet[]; connections: ConnectionState[]; queue: TransferJob[]; logs: LogEntry[]; recoveries: DocumentData[]; }
export interface Api {
  bootstrap: { args: void; result: BootstrapData };
  chooseFolder: { args: void; result: string | null };
  chooseFile: { args: { title?: string }; result: string | null };
  listLocal: { args: { path: string; showHidden?: boolean; filters?: FilterRule[] }; result: FileEntry[] };
  mutateLocal: { args: { operation: 'mkdir' | 'create' | 'rename' | 'delete' | 'copy' | 'move'; path: string; destination?: string }; result: void };
  saveProfile: { args: { profile: ConnectionProfile; credentials?: Credentials }; result: ConnectionProfile };
  deleteProfile: { args: { id: string }; result: void };
  connect: { args: { profile: ConnectionProfile; credentials?: Credentials }; result: ConnectionState };
  disconnect: { args: { connectionId: string }; result: void };
  listRemote: { args: { connectionId: string; path: string }; result: FileEntry[] };
  statRemote: { args: { connectionId: string; path: string }; result: FileEntry | null };
  mutateRemote: { args: { connectionId: string; operation: 'mkdir' | 'rename' | 'delete' | 'chmod'; path: string; destination?: string; mode?: string; recursive?: boolean; confirmed?: boolean }; result: void };
  searchRemote: { args: { connectionId: string; root: string; query: SearchQuery; requestId: string }; result: FileEntry[] };
  cancelSearch: { args: { requestId: string }; result: void };
  openDocument: { args: { path: string; connectionId?: string }; result: DocumentData };
  saveDocument: { args: { id: string; content: string; path?: string }; result: DocumentData };
  recoverDocument: { args: { id: string; content: string }; result: void };
  discardRecovery: { args: { id: string }; result: void };
  enqueue: { args: { requests: TransferRequest[] }; result: TransferJob[] };
  queueAction: { args: { action: 'pause' | 'resume' | 'cancel' | 'retry' | 'clear' | 'priority'; ids?: string[]; priority?: number }; result: void };
  saveProject: { args: { project: Project }; result: Project };
  deleteProject: { args: { id: string }; result: void };
  saveSettings: { args: { settings: AppSettings }; result: void };
  saveSnippet: { args: { snippet: Snippet }; result: Snippet };
  deleteSnippet: { args: { id: string }; result: void };
  searchProject: { args: { projectId: string; query: SearchQuery; requestId: string }; result: SearchResult[] };
  previewReplace: { args: { projectId: string; query: SearchQuery; replacement: string }; result: ReplacementPreview[] };
  applyReplace: { args: { changes: ReplacementPreview[] }; result: number };
  relatedFiles: { args: { path: string; content: string; projectId: string }; result: string[] };
  createPublishPlan: { args: { projectId: string; connectionId: string; environmentId?: string; direction: 'upload' | 'download' | 'both'; includeDependencies: boolean; paths?: string[] }; result: PublishPlan };
  executePublishPlan: { args: { planId: string; selectedPaths: string[]; productionConfirmed: boolean }; result: TransferJob[] };
  preview: { args: { projectId: string; path: string; browser?: 'default' | 'edge' | 'chrome'; external?: boolean }; result: string };
  readAsset: { args: { projectId: string; path: string }; result: { mime: string; base64: string } };
}
export interface StudioBridge {
  invoke<K extends keyof Api>(command: K, args: Api[K]['args']): Promise<Api[K]['result']>;
  on(event: 'queue' | 'log' | 'connections', listener: (data: unknown) => void): () => void;
}
declare global { interface Window { ftp: StudioBridge; } }
export interface RemoteSession {
  list(path: string, signal?: AbortSignal): Promise<FileEntry[]>;
  stat(path: string): Promise<FileEntry | null>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, directory: boolean): Promise<void>;
  chmod(path: string, mode: string): Promise<void>;
  upload(localPath: string, remotePath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset?: number): Promise<void>;
  download(remotePath: string, localPath: string, onProgress: (progress: TransferProgress) => void, signal: AbortSignal, offset?: number): Promise<void>;
  close(): Promise<void>;
}
export interface SessionLease { session: RemoteSession; release(): Promise<void>; }
export interface RemoteAccess {
  profile(connectionId: string): ConnectionProfile;
  acquire(connectionId: string, purpose: 'navigation' | 'transfer', signal?: AbortSignal): Promise<SessionLease>;
}
export interface KeyValueStore { get<T>(key: string, fallback: T): T; set<T>(key: string, value: T): void; delete(key: string): void; }
export type Logger = (level: LogEntry['level'], message: string, connectionId?: string) => void;
