import { describe, expect, it } from 'vitest';
import { commonUnixPermissions, formatUnixPermissions, parseUnixPermissions, toggleUnixPermission, unixPermissionWarnings } from '../src/core/permissions';

describe('Unix permission conversion', () => {
  it.each([['644', 0o644], ['0755', 0o755], ['000', 0], ['7777', 0o7777], ['rwxr-xr-x', 0o755], ['drwxrwxrwt', 0o1777], ['-rwSr-Sr-T', 0o7644], ['rwsr-sr-x', 0o6755]])('parses %s without losing special bits', (value, expected) => expect(parseUnixPermissions(value)).toBe(expected));
  it.each([undefined, '', '77777', '0888', '64', ' 644', '644 ', 'rwrr', 'rwxrxrx', 'drwxr-xr-x+', 'rwxrwxrwz'])('does not guess ambiguous/invalid mode %s', value => expect(parseUnixPermissions(value)).toBeNull());
  it('links every individual bit to its octal value and preserves the other bits', () => {
    for (let bit = 1; bit <= 0o4000; bit <<= 1) {
      expect(parseUnixPermissions(toggleUnixPermission('000', bit, true))).toBe(bit);
      expect(parseUnixPermissions(toggleUnixPermission('7777', bit, false))).toBe(0o7777 & ~bit);
    }
    expect(toggleUnixPermission('4755', 0o020, true)).toBe('4775');
    expect(toggleUnixPermission('', 0o400, true)).toBe('400');
    expect(() => toggleUnixPermission('89', 0o400, true)).toThrow();
    expect(() => toggleUnixPermission('644', 3, true)).toThrow();
  });
  it('prefills only unanimous trustworthy modes', () => {
    expect(commonUnixPermissions(['0755', 'rwxr-xr-x', '755'])).toBe('755');
    expect(commonUnixPermissions(['4755', 'rwsr-xr-x'])).toBe('4755');
    expect(commonUnixPermissions(['644', '755'])).toBe('');
    expect(commonUnixPermissions(['644', undefined])).toBe('');
    expect(commonUnixPermissions([])).toBe('');
  });
  it('warns precisely for world-write and special modes', () => {
    expect(unixPermissionWarnings('644')).toEqual([]);
    expect(unixPermissionWarnings('666')).toHaveLength(1);
    expect(unixPermissionWarnings('4755')).toHaveLength(1);
    expect(unixPermissionWarnings('1777')).toHaveLength(2);
    expect(unixPermissionWarnings('7777')).toHaveLength(3);
    expect(unixPermissionWarnings('888')).toEqual([]);
  });
  it('refuses modes outside twelve permission bits', () => {
    expect(formatUnixPermissions(0)).toBe('000');
    expect(() => formatUnixPermissions(0o10000)).toThrow();
    expect(() => formatUnixPermissions(-1)).toThrow();
    expect(() => formatUnixPermissions(1.5)).toThrow();
  });
});
