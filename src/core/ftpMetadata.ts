import { posix } from 'node:path';
import type { FileEntry } from '../shared/contracts';

function invalid(): never { throw new Error('De server stuurde ongeldige of dubbelzinnige MLST-metadata.'); }

/** Parse a single RFC 3659 MLST result without interpreting or following link targets. */
export function parseMlstMetadata(message: string, requestedPath: string): FileEntry {
  if (message.length > 65536 || !requestedPath.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(requestedPath) || requestedPath.split('/').includes('..')) invalid();
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  if (lines.length !== 3 || !/^250-/.test(lines[0]) || !/^250(?: |$)/.test(lines[2])) invalid();
  const record = /^ ([^ ]+) (.+)$/.exec(lines[1]);
  if (!record || !record[1].endsWith(';')) invalid();
  const returnedPath = record[2];
  // Some servers return the basename even for an absolute MLST argument. No
  // other relative path or canonicalized link target is accepted as that item.
  if (/[\\\x00-\x1f\x7f]/.test(returnedPath) || returnedPath !== requestedPath && returnedPath !== posix.basename(requestedPath)) invalid();
  const facts = new Map<string, string>();
  for (const raw of record[1].slice(0, -1).split(';')) {
    const fact = /^([a-zA-Z][a-zA-Z\d._-]*)=([^;\x00-\x20\x7f]+)$/.exec(raw);
    if (!fact || facts.has(fact[1].toLowerCase())) invalid();
    facts.set(fact[1].toLowerCase(), fact[2]);
  }
  const type = facts.get('type')?.toLowerCase();
  const kind = type === 'file' ? 'file' : type === 'dir' ? 'directory' : type && /^os\.unix=(?:slink|symlink)(?::.*)?$/.test(type) ? 'symlink' : invalid();
  // Vendor link facts must never turn a reported file into a followable target.
  if (kind !== 'symlink' && [...facts.keys()].some(name => /(?:^|\.)(?:slink|symlink|link)$/.test(name))) invalid();
  const sizeText = facts.get('size');
  if (kind === 'file' && sizeText === undefined || sizeText !== undefined && !/^\d+$/.test(sizeText)) invalid();
  const size = sizeText === undefined ? 0 : Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) invalid();
  let modifiedAt: number | null = null, precisionMs: number | undefined;
  const modify = facts.get('modify');
  if (modify !== undefined) {
    const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?$/.exec(modify);
    if (!date) invalid();
    const [year, month, day, hour, minute, second] = date.slice(1, 7).map(Number);
    const value = new Date(0);
    value.setUTCFullYear(year, month - 1, day);
    value.setUTCHours(hour, minute, second, Number((date[7] ?? '').padEnd(3, '0').slice(0, 3)));
    if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day || value.getUTCHours() !== hour || value.getUTCMinutes() !== minute || value.getUTCSeconds() !== second) invalid();
    modifiedAt = value.getTime(); precisionMs = date[7] ? 10 ** Math.max(0, 3 - date[7].length) : 1000;
  }
  let permissions: string | undefined;
  const unixMode = facts.get('unix.mode');
  if (unixMode !== undefined) {
    if (!/^[0-7]{3,6}$/.test(unixMode)) invalid();
    const mode = Number.parseInt(unixMode, 8), fileType = mode & 0o170000;
    if (mode > 0o177777) invalid();
    if (fileType && fileType !== (kind === 'file' ? 0o100000 : kind === 'directory' ? 0o040000 : 0o120000)) invalid();
    permissions = (mode & 0o7777).toString(8).padStart(3, '0');
  }
  return { name: posix.basename(requestedPath) || '/', path: requestedPath, kind, size, modifiedAt,
    ...(precisionMs === undefined ? {} : { precisionMs }), ...(permissions === undefined ? {} : { permissions }) };
}
