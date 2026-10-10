# Eisen en implementatiestatus

Statuslabels beschrijven repositorybroncode, niet een door Windows gevalideerd product.

- **Aanwezig in broncode:** codepad en UI/contracts bestaan; formele suite/build is nog niet groen aangetoond.
- **Gedeeltelijk:** bruikbare subset met expliciete grenzen.
- **Niet geverifieerd:** configuratie of code bestaat, maar runtime/platformbewijs ontbreekt.
- **Ontbreekt:** geen implementatie gevonden die de eis volledig levert.

| Eis | Status | Huidige dekking / open punt |
|---|---|---|
| Gecombineerde lokale en remote workspace | Aanwezig in broncode | Lokale en remote browser, projecten, rootmapping; Windows runtime niet geverifieerd. |
| Dreamweaver-achtige editorervaring | Gedeeltelijk | Monaco + beperkte bronbewuste HTML/CSS-inspector; geen complete vrije page builder of site designer. |
| Bestandscode bewerken en bewaren | Aanwezig in broncode | UTF-8 editor, save/recovery; typecheck en backendtests geslaagd. Renderer-/Windowsvalidatie open. |
| HTML/CSS source-preserving visuele patches | Gedeeltelijk | parse5/PostCSS bronranges en guarded operations; dynamische/ambigue bron blokkeert inspector. |
| PHP en templates | Gedeeltelijk | Bron blijft bewerkbaar in code-editor; PHP wordt niet uitgevoerd; lokale serverpreview optioneel; geen PHP dependencybeheer. |
| FTP | Aanwezig in broncode | `basic-ftp`; FTP is onversleuteld en servercompatibiliteit niet geverifieerd. |
| FTPS expliciet/impliciet | Aanwezig in broncode | Adapter/profielkeuze aanwezig; geen provider-/Windows validatie. |
| SFTP | Aanwezig in broncode | `ssh2-sftp-client`; fingerprint vooraf vereist; echte provider- en Windowsvalidatie ontbreekt. |
| Veilige hostkey/TLS-afhandeling | Gedeeltelijk | Onbekende SSH-key wordt niet automatisch vertrouwd; runtimegedrag en TLS-platformscenario's moeten nog releasegetest. |
| Credentialbescherming Windows DPAPI | Niet geverifieerd | Electron safeStorage-vault aanwezig; Windows DPAPI-resultaat op doelversies nog niet aangetoond. |
| Persistente lokale opslag | Aanwezig in broncode | SQLite onder Electron userData; Windows herstel/crashgedrag niet geverifieerd. |
| Bestandswachtrij met controle en herstel | Gedeeltelijk | Persistent queue, staging/snapshot/rollback, conflicten; protocollen verschillen. Geen byte-offset resume. |
| Bestandsoverdracht pauzeren/hervatten | Gedeeltelijk | Queue-acties aanwezig; hervatten begint bij nul, geen overdrachts-offset-resume. |
| Automatische continue synchronisatie | Ontbreekt | Er is handmatig plan- en queueproces; geen watcher of continue bidirectionele sync. |
| Veilig publicatieplan | Gedeeltelijk | Vergelijking, filters, selectie, productiebevestiging, conflictuitsluiting en manifest. Formele end-to-end-validatie ontbreekt. |
| Remote delete bij sync | Ontbreekt | Publicatie verwijdert remote items niet automatisch. |
| Filters en gevoelig-bestandbeveiliging | Aanwezig in broncode | Scopefilters en standaarduitsluitingen in transfer/publish. Namenlijsten zijn geen volledige DLP/secret scanner. |
| Project search/replace | Aanwezig in broncode | Preview, stale snapshotcontrole en backups; formele tests niet vastgesteld. |
| Preview van server-side PHP | Ontbreekt | App-runtime voert PHP niet uit; gebruiker kan loopback ontwikkelserver URL opgeven. |
| Volledige Dreamweaver+FileZilla-pariteit | Ontbreekt | Huidige app is een beperkte geïntegreerde werkplek en biedt niet alle functies van die producten. |
| Windows x64 distributie | Niet geverifieerd | Electron Builder ZIP-target geconfigureerd; artifact, start, signing en Windowsversies niet getest. |
| Typecheck en Vitest | Geverifieerd op Linux | Typecheck en volledige Vitest-reeks 173/173 geslaagd. Geen Windows- of desktop-e2e-bewijs. |
