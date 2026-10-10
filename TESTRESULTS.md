# Werkelijk uitgevoerde controles

Historie vanaf 9 oktober 2026; nieuwste resultaten staan onderaan. Omgeving: Linux x64, Node.js 24.19.0, npm 11.9.0. Windows en Electron zijn niet gestart.

| Controle | Resultaat | Bewijs / grens |
|---|---|---|
| `node --no-warnings scripts/offline-check.mjs` | 5/5 geslaagd | Echte bronmodules, tijdelijk bestandssysteem, SQLite en Node test runner. |
| `node --no-warnings scripts/verify-queue-offline.mjs` | 31/31 geslaagd | Ongewijzigde testbodies uit queue.test.ts met expliciet meegeleverde Node-assertadapter in plaats van Vitest. Echte lokale I/O; gecontroleerde remote testdubbel. |
| Vier geïsoleerde RemoteManager-controles | Geslaagd | Uitgevoerde bronextractie in tijdelijk Node-script: reservering navigatiesessie, limiet één, geannuleerde handshakes, disconnect tijdens handshake. Geen echte FTP/SSH-transporttest. |
| Syntaxtransformatie van 26 TypeScript-bestanden | Geslaagd op laatste controlemoment | Node stripTypeScriptTypes; geen semantische typecontrole, geen TSX-validatie. De volledige build blijft noodzakelijk. |
| Afzonderlijke workspace-racecontroles door subagent | Geslaagd | Gelijktijdige opslag, opnieuw aangemaakte bestemming, geen hardlinkondersteuning, behoud rechten, FIFO-weigering. Geen Windows-uitvoering. |
| `npm ls --depth=0 --offline` | Mislukt, ELSPROBLEMS | Dependencies ontbreken; geen node_modules of eerste package-lock aanwezig. |
| Volledige `npm test` / Vitest | Niet uitgevoerd | Vitest en parser/protocoldependencies ontbreken. |
| `npm run typecheck` | Niet uitgevoerd | TypeScript/types ontbreken. |
| `npm run build`, desktoptests en Windows ZIP | Niet uitgevoerd | Bouwtools/Electron ontbreken. Er is geen geverifieerde EXE. |
| FTP, FTPS, SFTP lokale integratietests | Geschreven, niet uitgevoerd | Tests met lokale servers en echte transportlibraries staan klaar. Libraries ontbreken en sandbox weigert lokale sockets zonder netwerktoestemming. |
| Windows DPAPI, GUI/DPI, NTFS-crashherstel | Niet uitgevoerd | Vereist Windows-testmachine. |

## Offline dekking

De vijf kerncontroles testen Windows-/UNC-/POSIX-padkoppeling en mapgrenzen; conservatieve metadatavergelijking en filters; SQLite-heropening en weigering van onveilige credentialopslag; UTF-8 BOM/CRLF, verouderde saves/vervangingsplannen en symlinks; gepauzeerd wachtrijherstel zonder netwerksessie.

De 31 wachtrijgevallen omvatten serveridentiteit vóór en tijdens sessieopening, profielwijziging na herstel, maprecursie, standaard- en projectfilters, gevoelige bestanden, gekoppelde hoofdmappen, begrensde paralleliteit, prioriteit, dubbele doelen, tijdelijke bestanden, terugzetten van originelen, tussentijdse lokale/serverwijzigingen, onvolledige overdrachten, snapshotbewaking, pauze/annulering, commitbescherming, maximaal vier pogingen totaal (drie automatische retries), herstel na afsluiten en behoud van onopgeloste herstelgegevens.

De remote testdubbel simuleert fouten en metadata expliciet; deze bewijst geen servercompatibiliteit, werkelijke netwerksnelheid of FTP/SSH-beveiliging. De vaulttest bewijst weigering van onveilige opslag, niet de werking van Windows DPAPI.

## Voorbereide volledige tests

`tests/source.test.ts`, `workspace.test.ts`, `publishing.test.ts`, `remote.test.ts`, `remoteSearch.test.ts`, `queue.test.ts`, `main.test.ts` en `security.test.ts` bevatten gerichte unit-/integratiegevallen. `tests/e2e/desktop.spec.ts` start de echte Electron-app en gebruikt geïsoleerde projectbestanden. `tests/e2e/renderer.spec.ts` voegt echte lokale bestandslijsten, 1.400 bestanden, Monaco/BOM/CRLF/undo, paneelherstel, Save As en aparte paden met twee lokale FTP-fixtures toe. De OS-pickerresponse wordt voor Save As gecontroleerd ingevuld; service/IPC/bestands-I/O blijven echt. Deze suites zijn pas geslaagd als hun echte runners succesvol zijn uitgevoerd. Hun aanwezigheid is geen performance- of desktopresultaat.

## Meetresultaten

Er zijn nog geen representatieve metingen van FTP/SFTP-doorvoer, duizendbestandoverdrachten, geheugengebruik of Windows-opstarttijd. De standaard vier transfers is een configureerbare ontwerpkeuze, geen op deze omgeving bewezen optimum.

## Aanvullende reviewcontroles, 9 oktober 2026

Deze aanvulling bewaart de eerdere resultaten hierboven. Een herhaalde run telt niet als een nieuw uniek testgeval en bewijst geen latere, nog gewijzigde code.

| Controle door A-reviewer | Werkelijk resultaat | Beperking |
|---|---|---|
| `virtualRange` uit de echte rendererutils, Node-asserties | 48 combinaties geslaagd: 0/1/10/10.000 rijen, 0/100/500 viewporthoogte, vier scrollposities; indexgrenzen, DOM-venstergrens en totale scrollhoogte gecontroleerd | Geen React-rendering, browser-scrolltest, timing of geheugenmeting. |
| CSS-prioriteitsuffix met commentaar | Drie exacte bronspan-asserties geslaagd voor `!important` en omliggende comments | Controle van de daadwerkelijke regexlogica, geen uitvoering van de parse5/PostCSS-suite. |
| SQLite/herstel/credential-weigering | Roundtrip/delete, geweigerde onveilige secretopslag en gepauzeerde herstelde queue zonder lease gecontroleerd | Overlapt kerncontroles; geen extra suiteaantal of DPAPI-bewijs. |
| Geplande loopback-previewrooktest | Niet uitgevoerd: socketlisten werd door sandbox geweigerd (`EPERM`) | Geen HTTP-, cookie- of browsersandboxresultaat. Er is daarna geen geslaagde rooktest geclaimd. |
| Nieuwe UI-integratie en metadata-search | Statisch gereviewd; volledige runner niet uitgevoerd | TSX, IPC-types, React-interactie en Electron-CSP blijven integratiechecks. |
| Latere queue-uitbreiding, `node --no-warnings scripts/verify-queue-offline.mjs` | Hoofdagent rapporteert 39/39 geslaagd | Uitbreiding van de eerdere 31 gevallen met modebehoud en nooit-overschrijven, ook bij maprecursie. Nog steeds Node-assertadapter en remote testdubbel; geen acht extra real-protocoltests. |
| `node --no-warnings scripts/verify-search-offline.mjs` | 7/7 geslaagd, door implementatieagent en onafhankelijk door A-reviewer uitgevoerd | Echte search/identity/filtermodules; metadatafixture, geen netwerk. BFS, filters/onbekende tijd, geen contenttoegang, case/regex, endpointwissel op drie momenten, annulering/leasevrijgave, onveilige namen/paden, numerieke grenzen en totaalgrens 50.000. |
| Workspace-opruimfouten, afzonderlijke Node-checks door workspaceagent | Geslaagd: oorspronkelijke schrijverfout plus cleanupfout behouden; hardlinkweigering plus cleanupfout behouden | Tijdelijke scripts, geen Vitest-run. Reproduceerbare regressies staan in `tests/workspace.test.ts`, nog niet via Vitest uitgevoerd. |
| Workspace-mode/listing/groeicontroles door workspaceagent | Mode 0664 behouden bij umask 077; maximaal 16 gelijktijdige metadata-aanvragen; ENOENT overgeslagen, EACCES doorgegeven; groeiende leesstroom na 65.536 bytes geweigerd | Linux-native deelcontroles, geen Windows-ACL-/ownerbewijs of representatieve listingbenchmark. |
| Laatste hercontrole door hoofdagent | 5/5 kernchecks, 39/39 queue, 7/7 search, 10/10 `scripts/verify-protocol-manager-offline.mjs`; `git diff --check` geslaagd | Managercheck voert de actuele geëxtraheerde managerbron uit met geïnjecteerde sessies. Geen echte protocolverbinding of Vitest. Eerdere aantallen hierboven blijven historische controlemomenten. |
| Laatste TypeScript-syntaxtransformatie door hoofdagent | 29 bron-/testbestanden geslaagd | Node stripTypeScriptTypes; vervangt geen TSX-build of semantische typecheck. De eerdere 26 was de vorige momentopname. |
| `node --no-warnings scripts/verify-workspace-permissions-offline.mjs` | Workspaceagent rapporteert 3/3 geslaagd | Echte workspacebron en tijdelijke POSIX-bestanden: umask 077 behoudt mode 0664; concurrente beperking naar 0600 vóór verplaatsen en op de verplaatste backup wordt geweigerd/behouden. A-reviewer heeft de extra pre/post-renamecontroles gelezen. Geen Windows-ACL/owner/attributentest. |

`scripts/benchmark-transfers.mts` is voorbereid voor echte loopback-FTP-uploads/downloads met 1/2/4/8 parallelle transfers, standaard 1.000 kleine en 16 grotere bestanden, hashverificatie, navigatielatentie en procesmetingen. Het is nog niet uitgevoerd. De server bewaart bytes in RAM; queue-opslag meet JSON-serialisatie in geheugen, geen SQLite/fsync. Zelfs een latere geslaagde run zou daarmee geen internet-, TLS/SSH-, Windows- of productieserverbenchmark zijn. `--quick` is uitsluitend een kleine rooktest.

De P0/P1-dekkingsmatrix in [SPECIFICATION.md](SPECIFICATION.md) bevat ook ontbrekende functies. Slagende infrastructuurtests sluiten die productgaten niet.

## Hercontrole — 10 oktober 2026

De hoofdagent heeft de vijf meegeleverde offline scripts uitgevoerd: kern **5/5**, wachtrij **39/39**, servermetadatazoeken **7/7**, sessiemanager **10/10**, POSIX-rechten **5/5**. De laatste set is uitgebreid van drie naar vijf gevallen: late chmod van de verplaatste oorspronkelijke inode wordt gedetecteerd, en een nieuwe inode op hetzelfde doelpad wordt niet gechmod. De nieuwe onafhankelijke A-reviewer heeft de rechten- en kernsets eveneens uitgevoerd en de gewijzigde handlelevensduur statisch goedgekeurd. De bijbehorende Vitest-regressies zijn geschreven, maar niet via Vitest uitgevoerd.

`npm ls --depth=0 --offline` bevestigt nog steeds **18 ontbrekende directe dependencies**. De netwerktoegangsaanvraag voor installatie is afgebroken zonder installatieresultaat. Er is geen nieuwe lockfile, volledige typecheck, Electron-start, live protocolbenchmark of Windows-build. De eerdere aantallen zijn historische testmomenten en mogen niet bij deze herhalingen worden opgeteld.

## Volledige verificatie na netwerkgoedkeuring — 10 oktober 2026

| Controle | Werkelijk resultaat | Grens |
|---|---|---|
| Begrensde HTTPS HEAD registry.npmjs.org/typescript met expliciete goedkeuring | HTTP 200 | Bewijst deze goedgekeurde route, niet netwerktoegang van de standaard sandbox. |
| npm install --ignore-scripts | 367 pakketten geïnstalleerd; package-lock.json aangemaakt | Overige installatiehooks niet automatisch uitgevoerd. |
| npm ls --depth=0 --offline | Exit 0; alle 18 directe dependencies aanwezig | Versies liggen vast in de lockfile. |
| Officiële Electron-installer | Exit 0; Electron 41.10.7 gedownload via proxy en checksumcontrole | Geen GUI-start of Windows-uitvoering. |
| npm run typecheck | Exit 0 | Echte TypeScript/TSX-controle, inclusief gedeclareerde bronnen en tests. |
| npm run build | Exit 0 | Main, preload, renderer en lokale Monaco-workers/assets gebouwd. Geen Windows-package. |
| Volledige Vitest-reeks met goedgekeurde loopback-sockets | **173/173 tests, 8/8 suites, exit 0; 27,25 s** | Linux, lokale fixtures; geen provider-, Windows- of representatieve prestatietest. |

Suiteaantallen: remote 40, queue 39, workspace 23, security 6, main 13, publishing 8, remoteSearch 20, source 24. Voor de laatste geslaagde run faalden drie gevallen: ongeschikt sleutelformaat in een SFTP-fixture, incorrect READDIR-longname in die fixture en een umask-afhankelijke testvoorwaarde. Alle drie zijn met behoud van de controles gerepareerd en onafhankelijk gereviewd. Eerder gesignaleerde echte CSS-bronrange- en HTML-veiligheidsproblemen zijn eveneens gerepareerd; de source-suite slaagt nu volledig.

De standaard-sandboxrun is afgebroken nadat protocoltestservers niet bruikbaar konden starten; er wordt daarvoor geen geslaagde volledige run geclaimd. De relevante fixtures weigeren voortaan expliciet een mislukte listen-aanvraag.

Deze actuele resultaten vervangen de eerdere status 'dependencies ontbreken/typecheck niet uitgevoerd'. De historische tabellen blijven staan als verslag. Desktop-e2e, GUI/DPI, Windows DPAPI en Windows-distributie zijn nog niet getest; resterende producteisen blijven open.
