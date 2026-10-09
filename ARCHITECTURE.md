# Architectuur

## Overzicht

FTP Studio is een Electron-desktopapp met drie hoofdgebieden:

- `src/renderer`: Nederlandstalige React-interface, bestandspanelen, Monaco-editor, beperkte visuele inspector, zoek-/publicatievensters en wachtrij.
- `src/main`: Electron-mainproces, IPC, profiel-/projectdiensten, remote protocol-adapters, preview en SQLite/safeStorage-integratie.
- `src/core`: protocolonafhankelijke lokale workspace, bronbewuste HTML/CSS-bewerking, filters, vergelijking, publicatieplanning en mapping tussen lokale en externe roots.
- `src/shared/contracts.ts`: gedeelde TypeScript-contracten voor IPC, projecten, profielen, bestanden, documenten en overdrachten.

De renderer spreekt met het mainproces via een beperkte preload-bridge. Bestands- en netwerk-I/O vindt in main/core plaats, niet in de renderer. Electron-instantiatie en Windows-integratie zijn nog niet op Windows gevalideerd.

## Bronnen bewerken

Monaco verzorgt codebewerking. HTML wordt met parse5 en bronposities geïnspecteerd; CSS wordt met PostCSS geparseerd. De editor past kleine patches toe op de originele tekst in plaats van een volledige DOM/CSS-serialisatie. Patches vereisen de actuele bronrevisie en worden afgewezen als parserstructuur of dynamische syntax de veilige wijziging onzeker maakt.

Dit is geen algemene sanitizer of sandbox. HTML-preview wordt in de geïsoleerde Electron-weergave getoond. Dynamische PHP-/templatebron wordt niet naar de preview gestuurd als uitvoerbare serverbron. Voor dergelijke bestanden is een expliciet ingestelde loopback-preview-URL nodig voor weergave via een door de gebruiker beheerde lokale server; de visuele inspector blijft geblokkeerd.

## Remote verbindingen en wachtrij

`basic-ftp` verzorgt FTP/FTPS en `ssh2-sftp-client` verzorgt SFTP. Sessies worden via leases beheerd. Transfers lopen via een persistente, begrensde wachtrij. De queue plant bestanden/mappen uit, begrenst expansie en parallelisme, controleert roots/symlinks/gevoelige paden, maakt stagingbestanden en verifieert waar mogelijk snapshots/checksums. Bij conflicten wordt de actie gestopt. Rollback gebruikt tijdelijke bestanden en snapshots; exacte garanties zijn afhankelijk van server en protocol.

FTP is een protocol zonder transportversleuteling. FTPS controleert TLS volgens de protocoladapter; SFTP vergelijkt de SSH-hostkey met de ingestelde SHA-256-fingerprint. Er is geen trust-on-first-use.

## Opslag en geheimen

`SqliteStore` slaat appstatus op in SQLite onder Electron `userData` (tenzij `FTP_STUDIO_DATA_DIR` expliciet is ingesteld). CredentialVault versleutelt credentials via Electron `safeStorage`; tekstwaarden komen niet als credentialveld in SQLite terecht. Beschikbaarheid en backendgedrag moeten bij de Windows-releasecontrole op de doelversies worden bevestigd. Windows gebruikt user-scoped systeemopslag/DPAPI via Electron.

## Publiceren

`core/publishing.ts` maakt een expliciet plan ten opzichte van de huidige remote listing en een lokaal opgeslagen manifest. Metadata kan onvoldoende zijn om verschil betrouwbaar vast te stellen; zulke items blijven onzeker/conflict en worden niet stil gekozen. Statische afhankelijkheden worden beperkt ontdekt. Een geselecteerde publicatie wordt als normale queue-transfer uitgevoerd. Manifestupdates vereisen geverifieerde overdracht. Er is geen automatisch verwijderen van remote bestanden.

## Build en platformstatus

Buildscripts gebruiken TypeScript, esbuild en Electron Builder. `npm run dist:win` vraagt een Windows x64 ZIP-target aan; de instelling is geen bewijs dat het commando of artifact is geslaagd. Op dit moment is de dependency-installatie geblokkeerd door shell-netwerktoegang, dus Windows-build, typecheck, Vitest en renderer-e2e zijn niet vastgesteld.
