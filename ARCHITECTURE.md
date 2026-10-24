# Architectuur

## Overzicht

FTP Studio is een Electron-desktopapp met drie hoofdgebieden:

- `src/renderer`: Nederlandstalige React-interface, bestandspanelen, Monaco-editor, beperkte visuele inspector, zoek-/publicatievensters en wachtrij.
- `src/main`: Electron-mainproces, IPC, profiel-/projectdiensten, remote protocol-adapters, preview en SQLite/safeStorage-integratie.
- `src/core`: protocolonafhankelijke lokale workspace, bronbewuste HTML/CSS-bewerking, filters, vergelijking, publicatieplanning en mapping tussen lokale en externe roots.
- `src/shared/contracts.ts`: gedeelde TypeScript-contracten voor IPC, projecten, profielen, bestanden, documenten en overdrachten.

De renderer spreekt met het mainproces via een beperkte preload-bridge. Bestands- en netwerk-I/O vindt in main/core plaats, niet in de renderer. Electron-instantiatie en Windows-integratie zijn nog niet op Windows gevalideerd.

IPC-verzoeken worden aan de vertrouwde hoofdframe-afzender gekoppeld. De ingebouwde HTML-preview gebruikt een iframe met `sandbox="allow-scripts"`, zonder same-originrecht; alleen geïnjecteerde selectiecode mag onder de nonce-CSP lopen. Projectscripts/eventhandlers worden uit deze preview verwijderd. Relatieve assets worden via begrensde main-processlezingen ingesloten. Dit is geen interne JavaScript-livepreview. De externe loopbackserver is een afzonderlijk pad met projectgebonden toegangstoken/cookie en voert zelf geen PHP uit. De Electron/CSP-grens heeft e2e-tests; de volledige GUI-suite slaagde 31/31 onder Linux/Xvfb. Dit valideert geen Windows-runtime of DPI-gedrag.

## Bronnen bewerken

Monaco verzorgt codebewerking. HTML wordt met parse5 en bronposities geïnspecteerd; CSS wordt met PostCSS geparseerd. De editor past kleine patches toe op de originele tekst in plaats van een volledige DOM/CSS-serialisatie. Patches vereisen de actuele bronrevisie en worden afgewezen als parserstructuur of dynamische syntax de veilige wijziging onzeker maakt.

Dit is geen algemene sanitizer of sandbox. HTML-preview wordt in de geïsoleerde Electron-weergave getoond. Dynamische PHP-/templatebron wordt niet naar de preview gestuurd als uitvoerbare serverbron. Voor dergelijke bestanden is een expliciet ingestelde loopback-preview-URL nodig voor weergave via een door de gebruiker beheerde lokale server; de visuele inspector blijft geblokkeerd.

## Remote verbindingen en wachtrij

`basic-ftp` verzorgt FTP/FTPS en `ssh2-sftp-client` verzorgt SFTP. Sessies worden via leases beheerd. Waar beschikbaar gebruikt de browser MLST voor strikte metadata; bij MLST 550 valt hij terug op listings. Transfers lopen via een persistente, begrensde wachtrij met incrementeel duurzaam SQLite-journal. Normale UI-statusupdates worden via een globale 100 ms timer samengevoegd; clear/close flushen direct. Dit is geen harde bovengrens voor update-latency. Duurzame transactiefasen worden direct opgeslagen. De queue plant bestanden/mappen uit, begrenst expansie en parallelisme, controleert roots/symlinks/gevoelige paden, maakt stagingbestanden en verifieert waar mogelijk snapshots/checksums. Bij conflicten wordt de actie gestopt. Rollback gebruikt tijdelijke bestanden en snapshots; exacte garanties zijn afhankelijk van server en protocol.

FTP is een protocol zonder transportversleuteling. FTPS controleert TLS volgens de protocoladapter; SFTP vergelijkt de SSH-hostkey met de ingestelde SHA-256-fingerprint. Er is geen trust-on-first-use.

`core/connectionIdentity.ts` bindt verbindingen aan protocol, host, poort, gebruiker, vertrouwde SFTP-hostkey en lokale/externe roots. `expectedEndpoint` voorkomt dat een opgeslagen profiel-id na wijziging naar een andere server wordt hergebruikt. Queue, listing/stat, mutaties, search, remote cache en publicatiemanifest controleren deze identiteit; async UI-acties bewaren hun oorspronkelijke context. Bestandsrijen worden alleen getoond voor de geladen endpoint/padcontext. Cachecompletions vernieuwen uitsluitend de baseline van hetzelfde lokale cachebestand en dezelfde serveridentiteit.

Automatisch herstel gebruikt exponentiële wachttijden en maximaal vier pogingen totaal, dus maximaal drie automatische retries; expliciet handmatig opnieuw proberen zet de teller terug. Transfers gebruiken eigen sessies, navigatie krijgt capaciteit binnen de profielgrens en een limiet van één serialiseert de leaseaanvragen. Er is daarnaast een globale grens van 32 actieve jobs. Pauzeren/hervatten gebruikt een veilige herstart vanaf byte nul. Onopgeloste transactiegegevens blijven bij clear bestaan.

FTP/SFTP bieden hier geen algemene server-side conditional rename/CAS. Metadata wordt vóór en tijdens een transfer opnieuw gecontroleerd, maar dezelfde grootte/tijdstempel kan gewijzigde inhoud verbergen, en een serverwijziging tussen controle en rename is niet generiek uit te sluiten. Een checksum is alleen sterker wanneer de server die daadwerkelijk betrouwbaar levert. Staging/backup is geen wereldwijde lock of atomaire publicatie van een hele site.

## Opslag en geheimen

`SqliteStore` slaat appstatus op in SQLite onder Electron `userData` (tenzij `FTP_STUDIO_DATA_DIR` expliciet is ingesteld). CredentialVault versleutelt credentials via Electron `safeStorage` en bindt ze aan de verbindingsidentiteit; tekstwaarden komen niet als credentialveld in SQLite terecht. Legacycredentials moeten opnieuw worden ingevoerd en opgeslagen. Beschikbaarheid en backendgedrag moeten bij de Windows-releasecontrole op de doelversies worden bevestigd. Windows gebruikt user-scoped systeemopslag/DPAPI via Electron.

Lokale saves schrijven een exclusief tijdelijk bestand, synchroniseren het, toetsen de oude inhoud en testen hardlinkondersteuning vóór het verplaatsen van het origineel naar `.ftp-studio-backups`. Een exclusieve hardlink installeert het nieuwe bestand en weigert een intussen opnieuw gemaakte bestemming. Herstel bewaart het origineel en vervangt geen nieuw aangetroffen bestand. Dit vereist hardlinks op hetzelfde bestandssysteem. POSIX-modebits worden meegenomen; Windows-ACL, eigenaar, alternate data streams en uitgebreide metadata worden niet gegarandeerd overgenomen. Windows/NTFS-crashgedrag en directory-fsyncgaranties zijn niet bewezen. Bewaarde backups hebben nog geen uitgewerkte retentiebediening.

## Publiceren

`core/publishing.ts` maakt een expliciet plan ten opzichte van de huidige remote listing en een lokaal opgeslagen manifest. Metadata kan onvoldoende zijn om verschil betrouwbaar vast te stellen; zulke items blijven onzeker/conflict en worden niet stil gekozen. Statische afhankelijkheden worden beperkt ontdekt. Een geselecteerde publicatie wordt als normale queue-transfer uitgevoerd. Manifestupdates vereisen geverifieerde overdracht. Er is geen automatisch verwijderen van remote bestanden.

## Build en platformstatus

Buildscripts gebruiken TypeScript, esbuild en Electron Builder. `npm run dist:win` vraagt een Windows x64 ZIP-target aan; de instelling is geen bewijs dat het commando of artifact is geslaagd. Dependencies en Electron zijn geïnstalleerd. Typecheck/build en Vitest (375/375, 16 suites, 63,25 s) slaagden in de vorige versie op Linux. Na de recentste wijzigingen lopen een geslaagde volledige Vitest-run en een lopende 31-scenario GUI-rerun. De eerder cross-gecompileerde Windows x64 ZIP is stale; definitieve packaging en Windows-runtimevalidatie blijven open.

Architectuuronderdelen die bestaan zijn niet gelijk aan volledige functionele dekking. Zie de oorspronkelijke P0/P1-matrix in [SPECIFICATION.md](SPECIFICATION.md) voor ontbrekende bediening en functies, en [TESTRESULTS.md](TESTRESULTS.md) voor de daadwerkelijk uitgevoerde offlinechecks.

### Laatste opslagcontrole van POSIX-rechten

De editor houdt zijn stagingbestand open tijdens de bestandswissel. Wijzigt de POSIX-mode van de bewaarde oorspronkelijke inode vóór de eindcontrole, dan rapporteert opslaan een conflict en beperkt het via de eigen filehandle zijn staginginode tot de doorsnede van de gedetecteerde rechten. Dit voorkomt chmod van een door een ander proces vervangen doelpad. Deze controles zijn geen atomair compare-and-swap met andere processen; wijzigingen ná de laatste controle, Windows-ACL's, ownership en aanvullende attributen vallen buiten de bewezen garantie.


De twee loopback-FTP-benchmarkmatrices zijn elk 16 scenario’s en controleerden 8.128 uitvoerbestanden met SHA-256. Zie [docs/BENCHMARKS.md](docs/BENCHMARKS.md) voor nulmeting, geoptimaliseerde meting en beperkingen. Resultaten gelden voor de betreffende Linux-testserver en niet als Windows-, internet- of productieproviderclaim.

## Toevoegingen op 10 oktober 2026

`documentComparison.ts` leest lokale of remote UTF-8-momentopnamen tot 8 MiB. Remote lezingen gebruiken afzonderlijke private tijdelijke bestanden en de vastgelegde documentbestemming, met metadata- en endpointcontrole vóór en na de overdracht. Maximaal vier vergelijkingen, time-out en afsluitopruiming begrenzen het werk. De renderer gebruikt aparte alleen-lezen Monaco-modellen; het sluiten van het venster negeert late resultaten.

Bestandskolommen worden per paneel onder `settings.layout.fileColumns` opgeslagen. Pointer- en toetsenbordacties bewaren alleen bij afronden; annuleren herstelt de eerdere breedte. `editorSplitPercent` volgt hetzelfde principe. Deze layoutwijzigingen veranderen geen bestanden.

De rendererbundel vervangt Monaco's ingebouwde DOMPurify door de expliciete 3.4.16-dependency. `dist/renderer/dependency-inputs.json` legt versie en daadwerkelijke bundelinput vast; de build faalt bij een afwijkende sanitizerbron.

## Grote overdrachtslijsten en logboeken

`QueuePanel` houdt de volledige gefilterde verzameling beschikbaar voor centrale acties en tellers, maar monteert alleen de zichtbare rijen, vijf extra rijen per kant en eventueel één gefocuste rij. `ResizeObserver` meet natuurlijke hoogtes zodat lange fout- en logteksten niet worden afgekapt. Meetgegevens zijn gekoppeld aan item-id, tekst en viewportbreedte. Een vooraf bewaarde scrollpositie ankert op dezelfde rij bij updates en herindeling; een remount bij filter- of tabwijziging begint bovenaan. Toetsenbordnavigatie kan niet-gemonteerde rijen bereiken. Er is geen extra runtimebibliotheek toegevoegd. Positieberekening en filtering blijven lineair in het aantal items; dit is DOM-virtualisatie, geen garantie van constante totale CPU-kosten.

## Handmatige overdrachten en herstelconflicten (1.0.1)

Handmatige bestandsacties geven `localRootOverride` mee: de op dat moment geopende lokale map. De wachtrij normaliseert en valideert deze bestaande absolute map, weigert symlinks/uitgesloten roots/cachemisbruik, beperkt alle nakomelingen tot deze map en bewaart de root in de opdracht. Uitvoering en retries controleren die root opnieuw. De serverroot en endpointcontroles blijven ongewijzigd. Projectfilters behouden binnen het project hun projectrelatieve paden; buiten het project gebruiken zij de expliciet gekozen overdrachtsmap.

De renderer gebruikt de geladen serverlisting voor verwachte doelmetadata en bevestiging van overschrijven; de backend controleert de actuele doelmetadata opnieuw. Selecties worden in groepen van 16 items aangeboden. Een groep blijft transactioneel voorbereid, maar voorgaande groepen kunnen al overdragen. Een fout meldt hoeveel opdrachten eerder zijn ingepland. Dit versnelt de start van selecties met veel bestanden; de recursieve controle van één grote geselecteerde map blijft vooraf plaatsvinden.

`clear` verwijdert gewone terminale opdrachten. Bij hersteltransacties bewaart het dezelfde volledige record met `archived: true`, verbergt die voor de UI en sluit haar uit van verdere planning en acties. Herstelbestanden worden niet verwijderd. Interne broncache-reconciliatie telt deze archieven mee, zodat geregistreerde herstelbronnen ook na herstart behouden blijven.
