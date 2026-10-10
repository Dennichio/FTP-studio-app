import { useRef, useState, type FormEvent } from 'react';
import { Plug } from 'lucide-react';
import type { ConnectionProfile, Credentials, Protocol } from '../../shared/contracts';
import { checkedProfile, defaultPort, newProfile } from './ProfileDialog';

export function QuickConnect({ localRoot, onConnect }: {
  localRoot?: string;
  onConnect: (profile: ConnectionProfile, credentials?: Credentials) => Promise<void>;
}) {
  const [protocol, setProtocol] = useState<Protocol>('sftp'), [port, setPort] = useState(22);
  const [host, setHost] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [hostKeySha256, setHostKeySha256] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const attemptPassword = password;
    try {
      const profile = checkedProfile({ ...newProfile(), name: `Direct: ${host.trim().slice(0, 180)}`, protocol, host, port, username, localRoot: localRoot || '', hostKeySha256: hostKeySha256.trim() || undefined }, false);
      if (!profile.localRoot) {
        const chosen = await window.ftp.invoke('chooseFolder', undefined);
        if (!chosen) { setError('Verbinden geannuleerd: kies een lokale hoofdmap.'); return; }
        profile.localRoot = chosen;
      }
      await onConnect(checkedProfile(profile), { password: attemptPassword });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(attemptPassword ? message.split(attemptPassword).join('[afgeschermd]') : message);
    } finally { setPassword(''); inFlight.current = false; setBusy(false); }
  };
  return <div className="direct-quickconnect-container"><form className="direct-quickconnect" aria-label="Direct verbinden" noValidate onSubmit={event => void connect(event)}>
    <select aria-label="Protocol voor direct verbinden" disabled={busy} value={protocol} onChange={e => { const selected = e.target.value as Protocol; setProtocol(selected); setPort(defaultPort(selected)); setError(''); }}>
      <option value="sftp">SFTP</option><option value="ftps">FTPS</option><option value="ftps-implicit">FTPS impliciet</option><option value="ftp">FTP</option>
    </select>
    <input aria-label="Host voor direct verbinden" placeholder="Host" disabled={busy} value={host} onChange={e => setHost(e.target.value)} spellCheck={false} autoComplete="off" />
    <input aria-label="Poort voor direct verbinden" title="Poort" type="number" min={1} max={65535} disabled={busy} value={port} onChange={e => setPort(Number(e.target.value))} />
    <input aria-label="Gebruikersnaam voor direct verbinden" placeholder="Gebruikersnaam" disabled={busy} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
    <input aria-label="Wachtwoord voor direct verbinden" placeholder="Wachtwoord" type="password" disabled={busy} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
    {protocol === 'sftp' && <input aria-label="SSH-hostvingerafdruk voor direct verbinden" title="Vertrouwde SHA256-hostvingerafdruk van uw hostingprovider" placeholder="SHA256:…" disabled={busy} value={hostKeySha256} onChange={e => setHostKeySha256(e.target.value)} spellCheck={false} autoComplete="off" />}
    <button type="submit" disabled={busy}><Plug size={13} />{busy ? 'Verbinden…' : 'Direct verbinden'}</button>
  </form>{error && <p className="quickconnect-feedback" role="status">{error}</p>}</div>;
}
