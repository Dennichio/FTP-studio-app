import { useRef, useState } from 'react';
import { Search, Replace, Square, FileCode2, Folder, Download, Pencil } from 'lucide-react';
import type { Project, ReplacementPreview, SearchResult, SearchQuery, FileEntry } from '../../shared/contracts';
import { formatDateTime, formatSize, id, joinPath, parentPath } from '../utils';
import { Check, Field, Modal } from './Modal';

type RemoteResults = { connectionId: string; endpoint?: string; root: string; entries: FileEntry[] };
export function SearchDialog({ project, connectionId, expectedEndpoint, remoteRoot, onClose, onOpen, onDone, onNavigateRemote }: {
  project: Project; connectionId?: string; expectedEndpoint?: string; remoteRoot: string;
  onClose: () => void; onOpen: (path: string, remote?: boolean, line?: number) => void; onDone: () => void;
  onNavigateRemote?: (path: string) => void;
}) {
  const [query, setQuery] = useState<SearchQuery>({ text: '', regex: false, caseSensitive: false, glob: '**/*', recursive: true });
  const [replacement, setReplacement] = useState(''), [results, setResults] = useState<SearchResult[]>([]);
  const [remoteResults, setRemoteResults] = useState<RemoteResults | null>(null);
  const [changes, setChanges] = useState<ReplacementPreview[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [scope, setScope] = useState<'project' | 'remote'>('project'), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [replaceMode, setReplaceMode] = useState(false);
  const [rename, setRename] = useState<{ entry: FileEntry; name: string } | null>(null);
  const request = useRef(''), closed = useRef(false);
  const currentContext = useRef({ connectionId, expectedEndpoint, remoteRoot });
  currentContext.current = { connectionId, expectedEndpoint, remoteRoot };
  const compatible = (found: RemoteResults | null): found is RemoteResults => !!found && !closed.current &&
    found.connectionId === currentContext.current.connectionId && found.endpoint === currentContext.current.expectedEndpoint && found.root === currentContext.current.remoteRoot;
  const close = () => { closed.current = true; if (request.current) void window.ftp.invoke('cancelSearch', { requestId: request.current }); onClose(); };
  const message = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const run = async (preview = false) => {
    if ((scope === 'project' || preview) && !query.text) { setError('Vul een zoekterm in.'); return; }
    if (scope === 'remote' && !connectionId) { setError('Maak eerst verbinding met een server.'); return; }
    setError(''); setBusy(true); setChanges([]); setRename(null);
    const requestId = id(); request.current = requestId;
    const context = { connectionId: connectionId!, endpoint: expectedEndpoint, root: remoteRoot };
    try {
      if (preview) { const found = await window.ftp.invoke('previewReplace', { projectId: project.id, query, replacement }); if (!closed.current) { setChanges(found); setSelected(found.map(f => f.path)); } }
      else if (scope === 'remote') {
        setRemoteResults(null);
        const entries = await window.ftp.invoke('searchRemote', { connectionId: context.connectionId, expectedEndpoint: context.endpoint, root: context.root, query, requestId });
        if (request.current === requestId && compatible({ ...context, entries })) setRemoteResults({ ...context, entries });
      } else setResults(await window.ftp.invoke('searchProject', { projectId: project.id, query, requestId }));
    } catch (e) { if (!closed.current) message(e); }
    finally { if (request.current === requestId) { request.current = ''; setBusy(false); } }
  };
  const act = async (entry: FileEntry, action: 'download' | 'rename') => {
    const found = remoteResults;
    if (!compatible(found)) { setError('De serverbestemming is gewijzigd. Zoek opnieuw.'); return; }
    setBusy(true); setError('');
    try {
      if (action === 'download') {
        const directory = await window.ftp.invoke('chooseFolder', undefined);
        if (!directory) return;
        if (!compatible(found)) throw new Error('De serverbestemming is gewijzigd. Zoek opnieuw.');
        await window.ftp.invoke('enqueue', { requests: [{ connectionId: found.connectionId, expectedEndpoint: found.endpoint, direction: 'download', overwriteExisting: false, expectedLocal: null, localPath: joinPath(directory, entry.name), remotePath: entry.path, projectId: project.id, priority: entry.kind === 'directory' ? 0 : 1, ...(entry.kind === 'file' ? { expectedRemote: { size: entry.size, modifiedAt: entry.modifiedAt, checksum: entry.checksum } } : {}) }] });
        setError('Download toegevoegd aan de wachtrij; bestaande bestanden worden niet overschreven.'); onDone();
      } else {
        const name = rename?.name.trim();
        if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error('Voer een geldige bestandsnaam in zonder pad.');
        const destination = joinPath(parentPath(entry.path), name);
        if (destination === entry.path) { setRename(null); return; }
        await window.ftp.invoke('mutateRemote', { connectionId: found.connectionId, expectedEndpoint: found.endpoint, operation: 'rename', path: entry.path, destination });
        setRemoteResults(value => value === found ? { ...found, entries: found.entries.filter(item => item.path !== entry.path && !item.path.startsWith(entry.path + '/')) } : value);
        setRename(null); setError('Naam gewijzigd. Zoek opnieuw om de actuele resultaten te zien.'); onDone();
      }
    } catch (e) { message(e); } finally { setBusy(false); }
  };
  const dateValue = (value?: number) => value === undefined ? '' : new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const validResults = compatible(remoteResults);
  return <Modal title="Zoeken in project en server" wide onClose={close} footer={<>
    <span className="modal-feedback" role="status">{error}</span><button onClick={close}>Sluiten</button>
    {changes.length > 0 && <button className="primary" disabled={busy || !selected.length} onClick={async () => { setBusy(true); try { const count = await window.ftp.invoke('applyReplace', { changes: changes.filter(c => selected.includes(c.path)) }); setChanges([]); setError(`${count} vervangingen toegepast.`); onDone(); } catch (e) { message(e); } finally { setBusy(false); } }}>Vervangen in {selected.length} bestanden</button>}
  </>}>
    <div className="search-top">
      <div className="input-action"><input aria-label="Zoekterm" placeholder={scope === 'remote' ? 'Bestandsnaam (optioneel bij filters)…' : 'Zoeken…'} value={query.text} onChange={e => setQuery({ ...query, text: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !busy) void run(); }} autoFocus />
        <button className="primary" disabled={busy} onClick={() => void run()}><Search size={15} />Zoeken</button>
        {busy && request.current && <button title="Zoekopdracht annuleren" onClick={() => void window.ftp.invoke('cancelSearch', { requestId: request.current })}><Square size={13} /></button>}
      </div>
      <div className="search-options"><Check label="Hoofdlettergevoelig" checked={query.caseSensitive} onChange={caseSensitive => setQuery({ ...query, caseSensitive })} /><Check label="Reguliere expressie (veilige subset)" checked={query.regex} onChange={regex => setQuery({ ...query, regex })} />
        <select aria-label="Zoeklocatie" disabled={busy} value={scope} onChange={e => { setScope(e.target.value as typeof scope); setChanges([]); setRename(null); setError(''); }}><option value="project">Lokaal project</option>{connectionId && <option value="remote">Serverbestanden</option>}</select>
        <input aria-label="Bestandspatroon" placeholder="**/*" value={query.glob} onChange={e => setQuery({ ...query, glob: e.target.value })} />
      </div>
      {scope === 'remote' && <div className="form-grid">
        <Field label="Relatief pad (wildcards)"><input placeholder="images/**" value={query.pathGlob || ''} onChange={e => setQuery({ ...query, pathGlob: e.target.value || undefined })} /></Field>
        <Field label="Type"><select value={query.kind || 'any'} onChange={e => setQuery({ ...query, kind: e.target.value as SearchQuery['kind'] })}><option value="any">Bestanden en mappen</option><option value="file">Bestanden</option><option value="directory">Mappen</option></select></Field>
        <Field label="Minimale grootte (bytes)"><input type="number" min="0" value={query.minSize ?? ''} onChange={e => setQuery({ ...query, minSize: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
        <Field label="Maximale grootte (bytes)"><input type="number" min="0" value={query.maxSize ?? ''} onChange={e => setQuery({ ...query, maxSize: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
        <Field label="Gewijzigd vanaf"><input type="datetime-local" value={dateValue(query.modifiedAfter)} onChange={e => setQuery({ ...query, modifiedAfter: e.target.value ? new Date(e.target.value).getTime() : undefined })} /></Field>
        <Field label="Gewijzigd tot"><input type="datetime-local" value={dateValue(query.modifiedBefore)} onChange={e => setQuery({ ...query, modifiedBefore: e.target.value ? new Date(e.target.value).getTime() : undefined })} /></Field>
        <Check label="Onderliggende mappen doorzoeken" checked={query.recursive !== false} onChange={recursive => setQuery({ ...query, recursive })} />
      </div>}
      {scope === 'project' && <><button className="subtle" onClick={() => setReplaceMode(!replaceMode)}><Replace size={14} />{replaceMode ? 'Vervangen verbergen' : 'Zoeken en vervangen'}</button>{replaceMode && <div className="input-action"><input aria-label="Vervangende tekst" placeholder="Vervangen door…" value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={busy} onClick={() => void run(true)}>Vervangingen bekijken</button></div>}</>}
    </div>
    <div className="search-results">
      {changes.length > 0 ? changes.map(c => <div className="replacement-preview" key={c.path}><Check label={`${c.path} · ${c.count} vervangingen`} checked={selected.includes(c.path)} onChange={v => setSelected(s => v ? [...s, c.path] : s.filter(x => x !== c.path))} /><div className="diff-pair"><pre>{c.before}</pre><pre>{c.after}</pre></div></div>) : scope === 'remote' ? validResults && remoteResults.entries.map(r => <div className="replacement-preview" key={r.path}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><button className="search-result" disabled={busy || (r.kind === 'directory' && !onNavigateRemote)} onClick={() => { if (!compatible(remoteResults)) return; if (r.kind === 'directory') onNavigateRemote?.(r.path); else onOpen(r.path, true); close(); }}>{r.kind === 'directory' ? <Folder size={14} /> : <FileCode2 size={14} />}<span>{r.path}<small>{r.kind === 'directory' ? 'Map' : formatSize(r.size)} · {formatDateTime(r.modifiedAt)}</small></span></button>
          <button title="Downloaden" disabled={busy} onClick={() => void act(r, 'download')}><Download size={15} /></button><button title="Hernoemen" disabled={busy} onClick={() => setRename({ entry: r, name: r.name })}><Pencil size={15} /></button><button disabled={busy || !onNavigateRemote} onClick={() => { if (compatible(remoteResults)) { onNavigateRemote?.(parentPath(r.path)); close(); } }}>Naar map</button>
        </div>{rename?.entry.path === r.path && <div className="input-action"><input aria-label="Nieuwe naam" value={rename.name} onChange={e => setRename({ entry: r, name: e.target.value })} /><button disabled={busy} onClick={() => void act(r, 'rename')}>Naam wijzigen</button><button onClick={() => setRename(null)}>Annuleren</button></div>}
      </div>) : results.map((r, i) => <button className="search-result" key={`${r.path}-${i}`} onClick={() => { onOpen(r.path, false, r.line); close(); }}><FileCode2 size={14} /><span>{r.path}<small><b>{r.line}:{r.column}</b> {r.text}</small></span></button>)}
      {busy && <div className="pane-empty">Bezig…</div>}
      {!busy && scope === 'remote' && !validResults && <div className="pane-empty">Zoek op naam, extensie, pad, grootte of wijzigingsdatum.</div>}
      {!busy && scope === 'remote' && validResults && !remoteResults.entries.length && <div className="pane-empty">Geen bestanden gevonden.</div>}
      {!busy && scope === 'project' && !results.length && !changes.length && <div className="pane-empty">Zoek in uw project of bekijk vervangingen voordat u ze toepast.</div>}
    </div>
  </Modal>;
}
