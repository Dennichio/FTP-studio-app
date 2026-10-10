import { useRef, useState } from 'react';
import type { FileEntry } from '../../shared/contracts';
import { commonUnixPermissions, parseUnixPermissions, toggleUnixPermission, unixPermissionWarnings } from '../../core/permissions';
import { Field, Modal } from './Modal';

export interface PermissionsDialogProps {
  entries: FileEntry[];
  host: string;
  onApply: (mode: string, recursive: boolean) => Promise<void>;
  onClose: () => void;
}
const groups = [
  { label: 'Eigenaar', bits: [0o400, 0o200, 0o100] },
  { label: 'Groep', bits: [0o040, 0o020, 0o010] },
  { label: 'Overigen', bits: [0o004, 0o002, 0o001] },
];
const rights = ['Lezen', 'Schrijven', 'Uitvoeren / map openen'];
const special = [
  { label: 'Setuid (4000)', bit: 0o4000 },
  { label: 'Setgid (2000)', bit: 0o2000 },
  { label: 'Sticky bit (1000)', bit: 0o1000 },
];

export function PermissionsDialog({ entries, host, onApply, onClose }: PermissionsDialogProps) {
  const [initial] = useState(() => commonUnixPermissions(entries.map(entry => entry.permissions)));
  const [mode, setMode] = useState(initial), [recursive, setRecursive] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const applying = useRef(false);
  const directories = entries.filter(entry => entry.kind === 'directory').length;
  const unsupported = entries.some(entry => entry.kind === 'symlink');
  const valid = /^[0-7]{3,4}$/.test(mode), numeric = valid ? parseUnixPermissions(mode)! : 0;
  const effectiveRecursive = directories > 0 && recursive;
  const changeMode = (value: string) => { setMode(value); setConfirmed(false); setError(''); };
  const close = () => { if (!applying.current) onClose(); };
  const toggle = (bit: number, enabled: boolean) => {
    try { changeMode(toggleUnixPermission(mode, bit, enabled)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'De rechten konden niet worden aangepast.'); }
  };
  const apply = async () => {
    if (applying.current || !valid || !entries.length || unsupported || effectiveRecursive && !confirmed) return;
    applying.current = true; setBusy(true); setError('');
    try { await onApply(mode, effectiveRecursive); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'De rechtenwijziging is mislukt.'); }
    finally { applying.current = false; setBusy(false); }
  };
  return <Modal title="Servermachtigingen" onClose={close} footer={<>
    <span className="modal-feedback" role={error ? 'alert' : undefined}>{error}</span>
    <button disabled={busy} onClick={close}>Annuleren</button>
    <button className="primary" disabled={busy || !valid || !entries.length || unsupported || effectiveRecursive && !confirmed} onClick={() => void apply()}>{busy ? 'Rechten wijzigen…' : 'Machtigingen toepassen'}</button>
  </>}>
    <p className="dialog-intro">{entries.length} geselecteerde {entries.length === 1 ? 'item' : 'items'} op <strong>{host}</strong>{directories > 0 ? ` · ${directories} ${directories === 1 ? 'map' : 'mappen'}` : ''}.</p>
    <details><summary>Geselecteerde paden en huidige rechten</summary><ul>{entries.map(entry => <li key={entry.path}>{entry.path} · {entry.permissions || 'onbekend'}</li>)}</ul></details>
    {!initial && <p className="notice">De huidige rechten verschillen of zijn niet betrouwbaar leesbaar. {mode ? 'De gekozen modus vervangt alle bestaande rechten.' : 'Kies expliciet de nieuwe rechten; er is nog geen modus geselecteerd.'}</p>}
    {unsupported && <p className="notice">Symbolische koppelingen kunnen niet worden gewijzigd. Sluit dit venster en selecteer gewone bestanden of mappen.</p>}
    <fieldset disabled={busy || unsupported || !entries.length} style={{ border: 0, padding: 0, margin: 0 }}>
      <Field label="Octale rechten" hint="Drie cijfers voor eigenaar, groep en overigen; een vierde cijfer bevat speciale rechten.">
        <input aria-label="Octale rechten" value={mode} onChange={event => changeMode(event.target.value)} placeholder="Bijvoorbeeld 644 of 755" inputMode="numeric" maxLength={4} spellCheck={false} aria-invalid={mode !== '' && !valid} />
      </Field>
      {mode !== '' && !valid && <p className="warning-text" role="status">Gebruik drie of vier cijfers van 0 tot en met 7.</p>}
      <div className="form-grid"><button onClick={() => changeMode('644')}>644 · bestand</button><button onClick={() => changeMode('755')}>755 · map / uitvoerbaar</button></div>
      <div className="form-grid">
        {groups.map(group => <fieldset key={group.label} style={{ border: '1px solid var(--border)', borderRadius: 5, marginTop: 12 }}><legend>{group.label}</legend>
          {group.bits.map((bit, index) => <label className="check" key={bit}><input type="checkbox" checked={!!(numeric & bit)} disabled={mode !== '' && !valid} onChange={event => toggle(bit, event.target.checked)} /><span>{rights[index]}</span></label>)}
        </fieldset>)}
      </div>
      <details open={valid && !!(numeric & 0o7000)}><summary>Speciale rechten</summary>
        {special.map(({ label, bit }) => <label className="check" key={bit}><input type="checkbox" checked={!!(numeric & bit)} disabled={mode !== '' && !valid} onChange={event => toggle(bit, event.target.checked)} /><span>{label}</span></label>)}
      </details>
      {unixPermissionWarnings(mode).map(warning => <p className="notice" key={warning}>{warning}</p>)}
      <p className="muted small">Deze modus vervangt alle rechten van de geselecteerde items, inclusief speciale rechten. De server kan rechtenwijzigingen weigeren.</p>
      {directories > 0 && <>
        <label className="check"><input type="checkbox" checked={recursive} onChange={event => { setRecursive(event.target.checked); setConfirmed(false); }} /><span>Ook toepassen op alle bestanden en submappen in de geselecteerde mappen</span></label>
        {effectiveRecursive && <>
          <p className="notice">Dezelfde modus geldt ook voor onderliggende bestanden en mappen. Uitvoerrecht is nodig om mappen te openen. Een onderbroken bewerking kan gedeeltelijk zijn uitgevoerd.</p>
          <label className="check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Ik bevestig dat modus {mode || '…'} recursief op de geselecteerde mappen en hun inhoud mag worden toegepast.</span></label>
        </>}
      </>}
    </fieldset>
  </Modal>;
}
