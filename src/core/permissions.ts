/** Parse only unambiguous Unix permissions; compressed rwx groups lose boundaries. */
export function parseUnixPermissions(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (/^[0-7]{3,4}$/.test(value)) return Number.parseInt(value, 8);
  const symbolic = /^[bcdlps-][rwxstST-]{9}$/.test(value) ? value.slice(1) : value;
  if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(symbolic)) return null;
  let mode = 0;
  for (let index = 0; index < 9; index++) {
    const permission = symbolic[index];
    if (permission !== '-' && permission !== 'S' && permission !== 'T') mode |= 1 << (8 - index);
  }
  if (/[sS]/.test(symbolic[2])) mode |= 0o4000;
  if (/[sS]/.test(symbolic[5])) mode |= 0o2000;
  if (/[tT]/.test(symbolic[8])) mode |= 0o1000;
  return mode;
}
export function formatUnixPermissions(mode: number): string {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Ongeldige Unix-rechten.');
  return mode.toString(8).padStart(3, '0');
}
export function commonUnixPermissions(values: Array<string | undefined>): string {
  if (!values.length) return '';
  const modes = values.map(parseUnixPermissions), first = modes[0];
  return first !== null && modes.every(mode => mode === first) ? formatUnixPermissions(first) : '';
}
export function toggleUnixPermission(value: string, bit: number, enabled: boolean): string {
  if (!Number.isInteger(bit) || bit < 1 || bit > 0o4000 || (bit & (bit - 1)) !== 0) throw new Error('Ongeldig rechtenbit.');
  const mode = value === '' ? 0 : /^[0-7]{3,4}$/.test(value) ? parseUnixPermissions(value) : null;
  if (mode === null) throw new Error('Voer eerst drie of vier octale cijfers (0–7) in.');
  return formatUnixPermissions(enabled ? mode | bit : mode & ~bit);
}
export function unixPermissionWarnings(value: string): string[] {
  const mode = /^[0-7]{3,4}$/.test(value) ? parseUnixPermissions(value) : null;
  if (mode === null) return [];
  const warnings: string[] = [];
  if (mode & 0o002) warnings.push('Iedereen krijgt schrijfrecht. Dit kan bestanden of mapinhoud wijzigbaar maken voor andere servergebruikers.');
  if (mode & 0o6000) warnings.push('Setuid of setgid is ingeschakeld. Dit kan uitvoerrechten of groepstoewijzing beïnvloeden; controleer het gewenste servergedrag.');
  if (mode & 0o1000) warnings.push('Sticky bit is ingeschakeld. In gedeelde mappen beperkt dit wie bestanden mag verwijderen of hernoemen.');
  return warnings;
}
