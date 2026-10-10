import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Code2 } from 'lucide-react';
import type { Snippet } from '../../shared/contracts';
import { id } from '../utils';
import { Field, Modal } from './Modal';
type Intent = { kind: 'select'; snippet: Snippet } | { kind: 'new' | 'close' | 'insert' };
const languages = ['html', 'css', 'javascript', 'typescript', 'php', 'json', 'plaintext'];
const blank = (group?: string): Snippet => ({ id: id(), name: 'Nieuw fragment', language: 'html', body: '', group });
const same = (a: Snippet, b: Snippet) => a.name === b.name && a.language === b.language && a.body === b.body && (a.group || '') === (b.group || '');

export function SnippetsDialog({ snippets, onClose, onSave, onDelete, onInsert }: {
  snippets: Snippet[]; onClose: () => void; onSave: (snippet: Snippet) => Promise<void>;
  onDelete: (id: string) => Promise<void>; onInsert: (text: string) => void;
}) {
  const [value, setValue] = useState<Snippet>(() => ({ ...(snippets[0] || blank()) }));
  const [baseline, setBaseline] = useState(value), [search, setSearch] = useState(''), [groupFilter, setGroupFilter] = useState('all');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Intent | null>(null), [confirmDelete, setConfirmDelete] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (groupFilter.startsWith('group:') && !snippets.some(snippet => snippet.group === groupFilter.slice(6))) setGroupFilter('all');
  }, [snippets, groupFilter]);
  const dirty = !same(value, baseline);
  const groups = [...new Set(snippets.flatMap(snippet => snippet.group ? [snippet.group] : []))].sort((a, b) => a.localeCompare(b, 'nl'));
  const query = search.trim().toLocaleLowerCase('nl');
  const matches = snippets.filter(snippet => (groupFilter === 'all' || (groupFilter === 'ungrouped' ? !snippet.group : snippet.group === groupFilter.slice(6))) &&
    [snippet.name, snippet.language, snippet.group || '', snippet.body].some(text => text.toLocaleLowerCase('nl').includes(query))).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const load = (snippet: Snippet) => { const copy = { ...snippet }; setValue(copy); setBaseline(copy); setError(''); };
  const perform = (intent: Intent) => {
    setPending(null);
    if (intent.kind === 'select') load(intent.snippet);
    else if (intent.kind === 'new') load(blank(groupFilter.startsWith('group:') ? groupFilter.slice(6) : undefined));
    else { if (intent.kind === 'insert') onInsert(value.body); onClose(); }
  };
  const request = (intent: Intent) => {
    if (inFlight.current || pending || confirmDelete) return;
    if (intent.kind === 'select' && intent.snippet.id === value.id) return;
    if (dirty) { setError(''); setPending(intent); } else perform(intent);
  };
  const save = async (): Promise<boolean> => {
    if (inFlight.current) return false;
    if (!value.name.trim()) { setError('Vul een naam voor het fragment in.'); return false; }
    const saved = { ...value, name: value.name.trim(), group: value.group?.trim() || undefined };
    inFlight.current = true; setBusy(true); setError('');
    try { await onSave(saved); setValue(saved); setBaseline(saved); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { inFlight.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await onDelete(value.id); setConfirmDelete(false); load(blank()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <><Modal title="Codefragmenten" wide onClose={() => request({ kind: 'close' })} footer={<>
    <span className="modal-feedback" role="status">{error || (dirty ? 'Niet-opgeslagen wijzigingen' : '')}</span>
    <button disabled={busy} onClick={() => request({ kind: 'close' })}>Sluiten</button>
    <button disabled={busy} onClick={() => void save()}>{busy ? 'Opslaan…' : 'Opslaan'}</button>
    <button className="primary" disabled={busy || !value.body} onClick={() => request({ kind: 'insert' })}><Code2 size={14} />Invoegen in editor</button>
  </>}><div className="manager-grid"><aside className="manager-list">
    <Field label="Fragmenten zoeken"><input type="search" placeholder="Naam, taal of broncode…" value={search} onChange={e => setSearch(e.target.value)} /></Field>
    <Field label="Groep bekijken"><select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
      <option value="all">Alle groepen</option><option value="ungrouped">Zonder groep</option>
      {groups.map(group => <option key={group} value={`group:${group}`}>{group}</option>)}
    </select></Field>
    <span className="muted small" role="status">{matches.length} fragmenten</span>
    {matches.map(snippet => <button key={snippet.id} disabled={busy} aria-pressed={snippet.id === value.id} className={snippet.id === value.id ? 'active' : ''} onClick={() => request({ kind: 'select', snippet })}><Code2 size={15} />{snippet.name}</button>)}
    {!matches.length && <p className="muted">Geen fragmenten gevonden.</p>}
    <button disabled={busy} onClick={() => request({ kind: 'new' })}><Plus size={15} />Nieuw fragment</button>
  </aside><div className="profile-form"><div className="form-grid">
    <Field label="Naam"><input disabled={busy} value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></Field>
    <Field label="Taal"><select disabled={busy} value={value.language} onChange={e => setValue({ ...value, language: e.target.value })}>{[...new Set([...languages, value.language])].map(language => <option key={language}>{language}</option>)}</select></Field>
  </div><Field label="Groep (optioneel)"><input disabled={busy} value={value.group || ''} maxLength={120} placeholder="Bijv. Layout of formulieren" onChange={e => setValue({ ...value, group: e.target.value })} /></Field>
    <Field label="Broncode"><textarea disabled={busy} className="snippet-body" value={value.body} onChange={e => setValue({ ...value, body: e.target.value })} spellCheck={false} /></Field>
    {snippets.some(snippet => snippet.id === value.id) && <button disabled={busy} className="danger-text subtle" onClick={() => { setError(''); setConfirmDelete(true); }}><Trash2 size={14} />Fragment verwijderen</button>}
  </div></div></Modal>
    {pending && <Modal title="Niet-opgeslagen fragment" onClose={() => { if (!inFlight.current) setPending(null); }} footer={<>
      <span className="modal-feedback" role="status">{error}</span><button disabled={busy} onClick={() => setPending(null)}>Annuleren</button>
      <button disabled={busy} onClick={() => perform(pending)}>Doorgaan zonder opslaan</button>
      <button disabled={busy} className="primary" onClick={async () => { if (await save()) perform(pending); }}>{busy ? 'Opslaan…' : 'Opslaan en doorgaan'}</button>
    </>}><p>Het fragment “{value.name}” bevat wijzigingen. Bewaar deze in de bibliotheek voordat u doorgaat.</p>
      {pending.kind === 'insert' && <p>Bij invoegen wordt de huidige broncode in de editor geplaatst, ook als u het fragment niet opslaat.</p>}
    </Modal>}
    {confirmDelete && <Modal title="Fragment verwijderen" onClose={() => { if (!inFlight.current) setConfirmDelete(false); }} footer={<>
      <span className="modal-feedback" role="status">{error}</span><button disabled={busy} onClick={() => setConfirmDelete(false)}>Annuleren</button>
      <button disabled={busy} className="danger" onClick={() => void remove()}>Verwijderen</button>
    </>}><p>Fragment “{value.name}” uit de bibliotheek verwijderen?{dirty && ' Ook de niet-opgeslagen wijzigingen gaan verloren.'}</p></Modal>}
  </>;
}
