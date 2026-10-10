# Eisen en implementatiestatus

Statuslabels beschrijven broncode en Linux-verificatie; Windows-runtime blijft open. Laatste volledige Vitest: 408/408. Desktop: 38/40 in de uitgebreide ronde, daarna 5/5 gerichte diffhercontrole na herstel. Zie TESTRESULTS.md voor de exacte uitvoeringen.

- **Aanwezig in broncode:** codepad en UI/contracts bestaan; build en Vitest zijn groen op Linux.
- **Gedeeltelijk:** bruikbare subset met expliciete grenzen.
- **Niet geverifieerd:** configuratie of code bestaat, maar runtime/platformbewijs ontbreekt.
- **Ontbreekt:** geen implementatie gevonden die de eis volledig levert.

| Eis | Status | Huidige dekking / open punt |
|---|---|---|
| Gecombineerde lokale en remote workspace | Aanwezig in broncode | Lokale en remote browser, projecten, rootmapping; Windows runtime niet geverifieerd. |
| Dreamweaver-achtige editorervaring | Gedeeltelijk | Monaco + beperkte bronbewuste HTML/CSS-inspector; geen complete vrije page builder of site designer. |
| Bestandscode bewerken en bewaren | Aanwezig in broncode | UTF-8 editor, save/recovery; typecheck, build en backendtests geslaagd; geselecteerde GUI-scenario’s slaagden onder Linux/Xvfb. De uitgebreide GUI-ronde haalde 38/40; na labelcorrectie slaagden alle vijf diffscenario’s. Windowsvalidatie blijft open. UTF-8 BOM/CRLF-behoud slaagde in geselecteerde GUI-controle. |
| HTML/CSS source-preserving visuele patches | Gedeeltelijk | parse5/PostCSS bronranges en guarded operations; dynamische/ambigue bron blokkeert inspector. |
| PHP en templates | Gedeeltelijk | Bron blijft bewerkbaar in code-editor; PHP wordt niet uitgevoerd; lokale serverpreview optioneel. Letterlijke PHP-includes kunnen als statische afhankelijkheden worden gevonden; dynamische includes en pakketbeheer ontbreken. |
| FTP | Aanwezig in broncode | `basic-ftp`; FTP is onversleuteld en servercompatibiliteit niet geverifieerd. |
| FTPS expliciet/impliciet | Aanwezig in broncode | Adapter/profielkeuze aanwezig; geen provider-/Windows validatie. |
| SFTP | Aanwezig in broncode | `ssh2-sftp-client`; fingerprint vooraf vereist; echte provider- en Windowsvalidatie ontbreekt. |
| Veilige hostkey/TLS-afhandeling | Gedeeltelijk | Onbekende SSH-key wordt niet automatisch vertrouwd; runtimegedrag en TLS-platformscenario's moeten nog releasegetest. |
| Credentialbescherming Windows DPAPI | Niet geverifieerd | Electron safeStorage-vault aanwezig; Windows DPAPI-resultaat op doelversies nog niet aangetoond. |
| Persistente lokale opslag | Aanwezig in broncode | SQLite onder Electron userData; Windows herstel/crashgedrag niet geverifieerd. |
| Bestandswachtrij met controle en herstel | Gedeeltelijk | Persistent queue, staging/snapshot/rollback, conflicten; protocollen verschillen. Geen byte-offset resume. |
| Bestandsoverdracht pauzeren/hervatten | Gedeeltelijk | Queue-acties aanwezig; hervatten begint bij nul, geen overdrachts-offset-resume. |
| Veilig publicatieplan | Gedeeltelijk | Vergelijking, filters, selectie, productiebevestiging, conflictuitsluiting en manifest. Echte Electron/FTP-scenario’s voor afhankelijkheden, nieuw serverconflict en productiebevestiging slagen. |
| Filters en gevoelig-bestandbeveiliging | Aanwezig in broncode | Scopefilters en standaarduitsluitingen in transfer/publish. Namenlijsten zijn geen volledige DLP/secret scanner. |
| Project search/replace | Aanwezig in broncode | Preview, stale snapshotcontrole en backups; backendregressies zijn opgenomen in de geslaagde Vitest-suite. Volledige GUI-dekking niet aangetoond. |
| Preview van server-side PHP | Gedeeltelijk | Gebruiker kan een loopback ontwikkelserver URL opgeven voor externe preview; de app voert zelf geen PHP uit. |
| Externe previewbrowser kiezen | Aanwezig in broncode | Keuze voor standaardbrowser, Edge of Chrome in de editor. Specifiek Edge/Chrome starten is alleen op Windows ondersteund en nog niet gevalideerd. |
| Volledige Dreamweaver+FileZilla-pariteit | Ontbreekt | Huidige app is een beperkte geïntegreerde werkplek en biedt niet alle functies van die producten. |
| Windows x64 distributie | Niet geverifieerd | Actuele x64 ZIP cross-compiled op Linux; x64-header, actuele assets, CRC en SHA-256 gecontroleerd. Windows-start, signing en Windowsversies niet getest. |
| Typecheck en Vitest | Geslaagd op Linux | Typecheck/build groen. Vitest 408/408 (19 suites, 63,29 s) met priority-, vergelijking- en herstelcorrecties. GUI: 38/40 gevolgd door 5/5 gerichte diffhercontrole. Windowsvalidatie blijft open. |
