# Architectuur

## Overzicht

FTP Studio is een Electron-desktopapp met drie hoofdgebieden:

- `src/renderer`: Nederlandstalige React-interface, bestandspanelen, Monaco-editor, beperkte visuele inspector, zoek-/publicatievensters en wachtrij.
- `src/main`: Electron-mainproces, IPC, profiel-/projectdiensten, remote protocol-adapters, preview en SQLite/safeStorage-integratie.
- `src/core`: protocolonafhankelijke lokale workspace, bronbewuste HTML/CSS-bewerking, filters, vergelijking, publicatieplanning en mapping tussen lokale en externe roots.
- `src/shared/contracts.ts`: gedeelde TypeScript-contracten voor IPC, projecten, profielen, bestanden, documenten en overdrachten.

De renderer spreekt met het mainproces via een beperkte preload-bridge. Bestands- en netwerk-I/O vindt in main/core plaats, niet in de renderer. Electron-instantiatie en Windows-integratie zijn nog niet op Windows gevalideerd.

IPC-verzoeken worden aan de vertrouwde hoofdframe-afzender gekoppeld. De ingebouwde HTML-preview gebruikt een iframe met `sandbox="allow-scripts"`, zonder same-originrecht; alleen geïnjecteerde selectiecode mag onder de nonce-CSP lopen. Projectscripts/eventhandlers worden uit deze preview verwijderd. Relatieve assets worden via begrensde main-processlezingen ingesloten. Dit is geen interne JavaScript-livepreview. De externe loopbackserver is een afzonderlijk pad met projectgebonden toegangstoken/cookie en voert zelf geen PHP uit. De daadwerkelijke Electron/CSP-grens heeft voorbereide, nog niet uitgevoerde e2e-tests.

## Bronnen bewerken

Monaco verzorgt codebewerking. HTML wordt met parse5 en bronposities geïnspecteerd; CSS wordt met PostCSS geparseerd. De editor past kleine patches toe op de originele tekst in plaats van een volledige DOM/CSS-serialisatie. Patches vereisen de actuele bronrevisie en worden afgewezen als parserstructuur of dynamische syntax de veilige wijziging onzeker maakt.

Dit is geen algemene sanitizer of sandbox. HTML-preview wordt in de geïsoleerde Electron-weergave getoond. Dynamische PHP-/templatebron wordt niet naar de preview gestuurd als uitvoerbare serverbron. Voor dergelijke bestanden is een expliciet ingestelde loopback-preview-URL nodig voor weergave via een door de gebruiker beheerde lokale server; de visuele inspector blijft geblokkeerd.

## Remote verbindingen en wachtrij

`basic-ftp` verzorgt FTP/FTPS en `ssh2-sftp-client` verzorgt SFTP. Sessies worden via leases beheerd. Transfers lopen via een persistente, begrensde wachtrij. De queue plant bestanden/mappen uit, begrenst expansie en parallelisme, controleert roots/symlinks/gevoelige paden, maakt stagingbestanden en verifieert waar mogelijk snapshots/checksums. Bij conflicten wordt de actie gestopt. Rollback gebruikt tijdelijke bestanden en snapshots; exacte garanties zijn afhankelijk van server en protocol.

FTP is een protocol zonder transportversleuteling. FTPS controleert TLS volgens de protocoladapter; SFTP vergelijkt de SSH-hostkey met de ingestelde SHA-256-fingerprint. Er is geen trust-on-first-use.

`core/connectionIdentity.ts` bindt verbindingen aan protocol, host, poort, gebruiker, vertrouwde SFTP-hostkey en lokale/externe roots. `expectedEndpoint` voorkomt dat een opgeslagen profiel-id na wijziging naar een andere server wordt hergebruikt. Queue, listing/stat, mutaties, search, remote cache en publicatiemanifest controleren deze identiteit; async UI-acties bewaren hun oorspronkelijke context. Bestandsrijen worden alleen getoond voor de geladen endpoint/padcontext. Cachecompletions vernieuwen uitsluitend de baseline van hetzelfde lokale cachebestand en dezelfde serveridentiteit.

Automatisch herstel gebruikt exponentiële wachttijden en maximaal vier pogingen totaal, dus maximaal drie automatische retries; expliciet handmatig opnieuw proberen zet de teller terug. Transfers gebruiken eigen sessies, navigatie krijgt capaciteit binnen de profielgrens en een limiet van één serialiseert de leaseaanvragen. Er is daarnaast een globale grens van 32 actieve jobs. Pauzeren/hervatten gebruikt een veilige herstart vanaf byte nul. Onopgeloste transactiegegevens blijven bij clear bestaan.

FTP/SFTP bieden hier geen algemene server-side conditional rename/CAS. Metadata wordt vóór en tijdens een transfer opnieuw gecontroleerd, maar dezelfde grootte/tijdstempel kan gewijzigde inhoud verbergen, en een serverwijziging tussen controle en rename is niet generiek uit te sluiten. Een checksum is alleen sterker wanneer de server die daadwerkelijk betrouwbaar levert. Staging/backup is geen wereldwijde lock of atomaire publicatie van een hele site.

## Opslag en geheimen

`SqliteStore` slaat appstatus op in SQLite onder Electron `userData` (tenzij `FTP_STUDIO_DATA_DIR` expliciet is ingesteld). CredentialVault versleutelt credentials via Electron `safeStorage`; tekstwaarden komen niet als credentialveld in SQLite terecht. Beschikbaarheid en backendgedrag moeten bij de Windows-releasecontrole op de doelversies worden bevestigd. Windows gebruikt user-scoped systeemopslag/DPAPI via Electron.

Lokale saves schrijven een exclusief tijdelijk bestand, synchroniseren het, toetsen de oude inhoud en testen hardlinkondersteuning vóór het verplaatsen van het origineel naar `.ftp-studio-backups`. Een exclusieve hardlink installeert het nieuwe bestand en weigert een intussen opnieuw gemaakte bestemming. Herstel bewaart het origineel en vervangt geen nieuw aangetroffen bestand. Dit vereist hardlinks op hetzelfde bestandssysteem. POSIX-modebits worden meegenomen; Windows-ACL, eigenaar, alternate data streams en uitgebreide metadata worden niet gegarandeerd overgenomen. Windows/NTFS-crashgedrag en directory-fsyncgaranties zijn niet bewezen. Bewaarde backups hebben nog geen uitgewerkte retentiebediening.

## Publiceren

`core/publishing.ts` maakt een expliciet plan ten opzichte van de huidige remote listing en een lokaal opgeslagen manifest. Metadata kan onvoldoende zijn om verschil betrouwbaar vast te stellen; zulke items blijven onzeker/conflict en worden niet stil gekozen. Statische afhankelijkheden worden beperkt ontdekt. Een geselecteerde publicatie wordt als normale queue-transfer uitgevoerd. Manifestupdates vereisen geverifieerde overdracht. Er is geen automatisch verwijderen van remote bestanden.

## Build en platformstatus

Buildscripts gebruiken TypeScript, esbuild en Electron Builder. `npm run dist:win` vraagt een Windows x64 ZIP-target aan; de instelling is geen bewijs dat het commando of artifact is geslaagd. De dependency-installatie en officiële Electron-download zijn na expliciete netwerkgoedkeuring geslaagd. Typecheck, esbuild-applicatiebuild en 173/173 Vitest-tests slagen op Linux; Windows-packaging, Windows-runtime en renderer-e2e zijn nog niet vastgesteld.

Architectuuronderdelen die bestaan zijn niet gelijk aan volledige functionele dekking. Zie de oorspronkelijke P0/P1-matrix in [SPECIFICATION.md](SPECIFICATION.md) voor ontbrekende bediening en functies, en [TESTRESULTS.md](TESTRESULTS.md) voor de daadwerkelijk uitgevoerde offlinechecks.

### Laatste opslagcontrole van POSIX-rechten

De editor houdt zijn stagingbestand open tijdens de bestandswissel. Wijzigt de POSIX-mode van de bewaarde oorspronkelijke inode vóór de eindcontrole, dan rapporteert opslaan een conflict en beperkt het via de eigen filehandle zijn staginginode tot de doorsnede van de gedetecteerde rechten. Dit voorkomt chmod van een door een ander proces vervangen doelpad. Deze controles zijn geen atomair compare-and-swap met andere processen; wijzigingen ná de laatste controle, Windows-ACL's, ownership en aanvullende attributen vallen buiten de bewezen garantie.
