import { describe, expect, it } from 'vitest';
import { parseMlstMetadata } from '../src/core/ftpMetadata';

const reply = (facts: string, filename = '/site/a.txt') => `250-Listing\r\n ${facts} ${filename}\r\n250 End`;
describe('strict single-item FTP metadata', () => {
  it('parses exact file metadata, spaces in names, case-insensitive facts and subsecond precision', () => {
    expect(parseMlstMetadata(reply('Type=file;Size=123;Modify=20261010121530.12;UNIX.mode=0640;', '/site/a b.txt'), '/site/a b.txt')).toEqual({ name: 'a b.txt', path: '/site/a b.txt', kind: 'file', size: 123, modifiedAt: Date.UTC(2026, 9, 10, 12, 15, 30, 120), precisionMs: 10, permissions: '640' });
    expect(parseMlstMetadata(reply('type=file;size=0;modify=20260228010203.123456;'), '/site/a.txt').precisionMs).toBe(1);
  });
  it('accepts an exact basename and keeps missing timestamp uncertainty', () => {
    expect(parseMlstMetadata(reply('type=file;size=0;', 'a.txt'), '/site/a.txt')).toEqual({ name: 'a.txt', path: '/site/a.txt', kind: 'file', size: 0, modifiedAt: null });
    expect(parseMlstMetadata(reply('type=dir;unix.mode=040755;', '/site'), '/site')).toMatchObject({ kind: 'directory', size: 0, permissions: '755' });
  });
  it.each(['OS.unix=slink:/outside/secret', 'OS.unix=symlink', 'OS.unix=symlink:/outside/secret'])('reports link type %s without using its target', type => {
    expect(parseMlstMetadata(reply(`type=${type};`), '/site/a.txt')).toMatchObject({ path: '/site/a.txt', kind: 'symlink' });
  });
  it.each([
    'size=1;', 'type=file;', 'type=fifo;size=1;', 'type=cdir;size=1;',
    'type=file;TYPE=dir;size=1;', 'type=file;size=1;size=1;',
    'type=file;size=-1;', 'type=file;size=1.5;', 'type=file;size=1e3;',
    'type=file;size=9007199254740992;', 'type=file;size=1;broken;',
    'type=file;size=1;modify=20260230000000;', 'type=file;size=1;modify=20261301000000;',
    'type=file;size=1;modify=20261010240000;', 'type=file;size=1;modify=20261010126000;',
    'type=file;size=1;modify=20261010120060;', 'type=file;size=1;modify=not-a-date;',
    'type=file;size=1;unix.mode=120777;', 'type=file;size=1;unix.mode=020644;',
    'type=file;size=1;unix.mode=777777;', 'type=file;size=1;unix.mode=0888;',
    'type=file;size=1;unix.slink=/outside;',
  ])('rejects malformed, conflicting or special-file metadata: %s', facts => expect(() => parseMlstMetadata(reply(facts), '/site/a.txt')).toThrow(/MLST-metadata/));
  it.each(['/other/a.txt', '/site/../a.txt', '../a.txt', './a.txt', '/site//a.txt', 'a.txt\0suffix', 'a.txt\n250 injected', 'C:\\a.txt'])('rejects mismatched or unsafe response path %s', filename => {
    expect(() => parseMlstMetadata(reply('type=file;size=1;', filename), '/site/a.txt')).toThrow();
  });
  it('rejects absent/multiple records, unexpected reply envelopes and oversized results', () => {
    for (const message of ['250 No data', '250-Listing\n250 End', '250-Listing\n type=file;size=1; /site/a.txt\n type=dir; /site\n250 End', '200-Listing\n type=file;size=1; /site/a.txt\n200 End', reply(`type=file;size=1;unique=${'x'.repeat(66000)};`)]) {
      expect(() => parseMlstMetadata(message, '/site/a.txt')).toThrow();
    }
  });
  it('does not put response contents in diagnostics', () => {
    expect(() => parseMlstMetadata(reply('type=SECRET_VALUE;'), '/site/a.txt')).toThrow('De server stuurde ongeldige of dubbelzinnige MLST-metadata.');
  });
});
