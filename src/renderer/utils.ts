import type { FileEntry } from '../shared/contracts';
export function joinPath(root: string, leaf: string): string { const sep = root.includes('\\') ? '\\' : '/'; return root.replace(/[\\/]+$/, '') + sep + leaf.replace(/^[\\/]+/, ''); }
export function parentPath(path: string): string { const clean = path.replace(/[\\/]+$/, ''); const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')); if (i < 0) return path; if (i === 0) return '/'; if (i === 2 && /^[A-Za-z]:/.test(clean)) return clean.slice(0, 3); return clean.slice(0, i); }
export function relativeTo(root: string, path: string): string | null { const norm = (s: string) => { const converted=s.replace(/\\/g,'/'); const prefix=converted.startsWith('//')?'//':converted.startsWith('/')?'/':''; const parts:string[]=[]; for(const part of converted.split('/')) { if(part==='..'){if(parts.length&&!parts[parts.length-1].endsWith(':'))parts.pop();else parts.push('..');} else if(part&&part!=='.')parts.push(part); } return (prefix+parts.join('/')).replace(/\/+$/,''); }; const r = norm(root), p = norm(path); const windows = /^[A-Za-z]:/.test(root); if ((windows ? p.toLowerCase() : p) === (windows ? r.toLowerCase() : r)) return ''; if (!(windows ? p.toLowerCase() : p).startsWith((windows ? r.toLowerCase() : r) + '/')) return null; return p.slice(r.length + 1); }
export function formatSize(n: number): string { if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`; return `${(n / 1073741824).toFixed(1)} GB`; }
export function language(path: string): string { const ext = path.split('.').pop()?.toLowerCase(); return ({html:'html',htm:'html',php:'php',css:'css',scss:'scss',js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',md:'markdown',xml:'xml',svg:'xml',yml:'yaml',yaml:'yaml',sql:'sql'} as Record<string,string>)[ext || ''] || 'plaintext'; }
export function fileIconType(file: FileEntry): string { if (file.kind === 'directory') return 'folder'; return language(file.name); }
export const id = () => crypto.randomUUID();
export const defaultFilters = () => ({ display: [], transfer: [], sync: [] });
export const compareLabels: Record<string,string> = {'local-newer':'Lokaal nieuwer','remote-newer':'Server nieuwer','local-only':'Alleen lokaal','remote-only':'Alleen server','probably-identical':'Waarschijnlijk gelijk',conflict:'Conflict',uncertain:'Onbekend'};
/** A fixed-height window keeps large directory DOM size bounded while retaining the full selection. */
export function virtualRange(total:number,scrollTop:number,viewportHeight:number,rowHeight=27,overscan=8):{start:number;end:number;before:number;after:number} {
  const count=Math.max(0,Math.floor(total));
  const height=Math.max(1,rowHeight),visible=Math.max(1,Math.ceil(Math.max(0,viewportHeight)/height));
  const first=Math.min(Math.max(0,count-visible),Math.max(0,Math.floor(Math.max(0,scrollTop)/height)));
  const start=Math.max(0,first-overscan),end=Math.min(count,first+visible+overscan);
  return {start,end,before:start*height,after:Math.max(0,count-end)*height};
}
