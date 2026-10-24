# Voortgang

## Huidige stand — 24 oktober 2026

Versie **1.0.1** bevat directe overdrachtsfeedback, batches van 16 geselecteerde items, handmatige overdrachten buiten de lokale profielmap en verwijderbare conflicten met behoud van herstelgegevens. Typecheck en build slagen. **420/420 backendtests** in de volledige ronde plus **3/3 aanvullende service-integratietests** slagen; de volledige Electron/Xvfb-ronde slaagt **51/51 (2,4 min)**. Onafhankelijke A-review akkoord. De zelfstandige Windows x64-ZIP is op inhoud, CRC en SHA-256 gecontroleerd; Windows-uitvoering is in deze omgeving niet getest. De volledige masterprompt blijft onafgerond.

Netwerktoegang voor npm en Electron is opgelost via expliciete uitvoeringsgoedkeuring. Geen cloudmigratie nodig. De laatste ontwikkelronde omvat MLST-metadata, incrementele SQLite-queue, veilig remote aanmaken/kopiëren/verplaatsen, DOM-boom, externe CSS-patches, alleen-lezen bestandsdiff, instelbare kolommen en code/canvasverdeling. Nieuwere hersteltekst blijft bij opslaan behouden. De onafhankelijke A-reviews zijn akkoord; gerichte en volledige tests staan in TESTRESULTS.md.

Op verzoek om binnen het resterende gebruiksbudget een Windows-app te bezorgen, krijgt het actuele downloadpakket voorrang op nieuwe uitbreidingen. Dit is een bruikbare ontwikkelbuild; resterende masterpromptfuncties worden niet als voltooid gemarkeerd.

## Werkverdeling zoals opgegeven

- Model A (Astra): overdrachtsintegriteit, bronpatches en onafhankelijke beveiligingsreview.
- Model B (GPT-6.1-Sol): UI, remote verbindingen en workspace.
- Model C (GPT-6-Luna): deze documentatie.
- Hoofdagent: integratie en beschikbare verificatie.

De verdeling geeft taaktoewijzing weer en is geen onafhankelijke kwaliteitscertificering. De C-documentatie is daarna door de A-reviewer bijgewerkt aan de hand van concrete brondekking. Hoofdagent moet wijzigingen/reviews en resultaten bij release aanvullen.

## Resterend werk na dit opleverpunt

1. Windows 11 x64-uitvoering, DPI, native dialoogvensters, DPAPI en NTFS-herstel controleren; dit vereist een Windows-testomgeving.
2. De oorspronkelijke P0/P1-matrix afronden, waaronder volledige CSS-cascade/overerving, uitgebreidere canvaslayout, interne JavaScript-preview en aanvullende taalformatters.
3. Representatieve hostingservers, ondersteunde hervatstrategieën en uiteindelijke distributieafwerking valideren. De huidige ZIP is niet ondertekend.

De dagelijkse workflow is verder ontwikkeld dan de volledige visuele websitebouwer. De aan de gebruiker gegeven voortgangsschatting (circa 85% voor dagelijkse workflow, circa 70% voor de gehele opdracht) is een ruwe inschatting, geen gemeten acceptatiepercentage. Zie [SPECIFICATION.md](SPECIFICATION.md).

## Uitgevoerde onafhankelijke reviews

De volgende review- en checkpointsecties zijn historisch. Hun toenmalige testblokkades worden vervangen door de huidige stand bovenaan en de actuele desktopstatus onderaan.

GPT-6 Astra controleerde de B-modelcode voor UI, protocollen en werkruimtediensten; een afzonderlijke Astra-agent controleerde ook opslag, preview, desktopbrug en documentatie van GPT-6 Luna. Gevonden fouten rond uploadbestemming, verouderde synchronisatiemanifesten, onveilige bestandswissels, geheime foutteksten, groeiende downloadstreams en speciale bestanden zijn hersteld of in regressietests opgenomen. Nieuwe desktopcode en protocoltests zijn sindsdien gebouwd en deels uitgevoerd; zie de actuele resultaten hieronder en TESTRESULTS.md. Twee subagents stopten later wegens een gemelde modelgebruikslimiet; de hoofdagent nam hun resterende integratie over.

### Aanvullende integratiereview op 9 oktober 2026

Na die eerdere onderbreking is de A-review hervat. De review omvat renderer, bronpatches, main/preload/storage/preview/service en de overdrachtsintegratie; de queue-reviewer beoordeelt daarnaast protocollen, workspace en publiceren. Dit is een afgebakende statische review plus de expliciet vermelde offlinecontroles, geen certificering van alle paden.

Nieuw gecontroleerde integratie bevat een gedeelde endpointidentiteit voor profielen, verzoeken en remote caches; controle vóór en na sessieacquisitie; snapshots uit de voltooide transfer in plaats van een latere serverstat; geen baselinevernieuwing voor een andere lokale cache; coalescing van gelijktijdig openen van hetzelfde remote document; vaste bronrevisie bij DOM-drag; behoud van BOM en CSS-`!important`; per-verbindingpadstaat en contextgebonden, gevirtualiseerde bestandsrijen. Save As is nu bereikbaar. Remote metadata-search en resultaatbediening zijn toegevoegd en moeten nog door de volledige runner/desktop worden gecontroleerd.

De A-review meldde ook dat downloaden uit zoekresultaten zonder expliciete bescherming bestaande lokale bestanden kon vervangen. De integratie bevat nu een nooit-overschrijvenoptie, inclusief recursieve kinderen; de hoofdagent rapporteerde 39/39 offline queuegevallen na deze en de modebehoudwijzigingen. De aanvullende statische review van remoteSearch, Save As, workspace-opruimfouten en deze queuedelta's vond geen nieuwe ernstige fout. Dit is reviewhistorie, geen claim van een geslaagde desktoptest. Na de eerder gemelde ontbrekende bestandspaneel-drag-and-drop is interne cross-pane transferdrag toegevoegd en statisch gereviewd: eenmalig intern token, vaste paneel-/endpointcontext, afwijzen van stale/same-pane/linkdrops en hergebruik van de bewaakte transferactie. Externe OS-drag/drop is niet geïmplementeerd. Dit staat los van DOM-drag in de editor.

Lokale hardlinktransacties vereisen ondersteuning van het bestandssysteem en garanderen geen Windows-ACL/ADS-behoud. Remote metadata plus staging bieden geen server-side compare-and-swap. De queue doet maximaal vier pogingen totaal (drie automatische retries), niet vier retries. Deze grenzen staan ook in architectuur en specificatie.

## Hercontrole en checkpoint — 10 oktober 2026

De voorafgaande netwerktoegangsaanvraag voor `npm install --ignore-scripts` leverde geen installatie-uitvoer op en is na langdurig wachten afgebroken. Tijdens die geblokkeerde toolaanroep werkte de hoofdagent niet verder. Na hervatting waren de oude subagents niet meer live; hun bestanden waren behouden. Een nieuwe GPT-6 Astra-agent (`final_integrity_review`, high) heeft de laatste opslag- en rendererwijzigingen onafhankelijk beoordeeld.

Die review vond een late POSIX-rechtenrace. De hoofdagent houdt nu de staginghandle vast tot na de laatste controle. Een gedetecteerde rechtenwijziging van het oorspronkelijke inode leidt tot een fout en beperking van uitsluitend het eigen staginginode; een inmiddels vervangen doelpad wordt niet aangeraakt. Twee regressies reproduceren zowel deze race als een ander proces dat het doelpad vervangt. De reviewer heeft de reparatie goedgekeurd en de vijf rechtencontroles en vijf kerncontroles opnieuw uitgevoerd. Een wijziging ná de laatste controle blijft een niet-atomaire grens; Windows-ACL/ownership/attributen zijn niet geverifieerd.

De hoofdagent heeft opnieuw 5 kern-, 39 wachtrij-, 7 metadatazoek-, 10 sessiemanager- en uiteindelijk 5 POSIX-rechtencontroles uitgevoerd: alle geslaagd. De broncode is een ontwikkelcheckpoint; volledige P0/P1-afwerking blijft open. Er wordt geen uitvoerbaar Windows-product opgeleverd of als gereed aangemerkt.

## Historische bouw-/unitcontrole vóór de laatste codewijzigingen

De root-agent gebruikte de beschikbare `exec_command` met expliciete `require_escalated`-goedkeuring voor één begrensde HTTPS-proef. De registry gaf HTTP 200. Vervolgens zijn alle 367 opgeloste pakketten geïnstalleerd met `--ignore-scripts`; de lockfile ligt vast. De officiële Electron 41.10.7-runtime is apart via de ingestelde proxy en ingebouwde checksumcontrole opgehaald. Een nieuwe cloudomgeving is voor deze downloads niet nodig.

De eerste echte compilatie vond ontbrekende `.js`-suffixen in Monaco-imports, een discriminant/typeprobleem in de source-engine en verouderde SFTP-typebeschrijvingen. De eerste bronparsertests vonden daarnaast CSS-offsetfouten en onvoldoende weigering van onbetrouwbare HTML-bronranges. Die fouten zijn gericht gerepareerd. Het B-model `protocol_build_fixes` verzorgde de protocolcompatibiliteit en testfixtures; A-model `source_build_fixes` herstelde de parser en reviewde de protocolwijzigingen onafhankelijk. De hoofdagent controleerde de brondelta en integreerde de renderer- en fixturecorrecties.

Resultaten op dat historische controlemoment: `npm run typecheck` exit 0, `npm run build` exit 0, `timeout 180s npm test` met goedgekeurde lokale sockets exit 0 en **173/173 tests in acht suites**. De suite gebruikt ook echte FTP-/SFTP-sockets en FTPS-certificaatweigering. Correcties in fixtures betroffen een geldig versleuteld PKCS1-sleutelformaat, correcte Unix-longnames en expliciete POSIX-testrechten; productiebeveiligingscontroles zijn niet versoepeld.

De applicatie is hiermee nog niet releaseklaar. De Electron-GUI/e2e, Windows-build en Windows-runtimevalidatie zijn niet uitgevoerd en de overige functionele gaten in de P0/P1-matrix blijven open. De broncode, lockfile en geschiedenis zijn opnieuw verpakt voor overdracht; geïnstalleerde node_modules en platformbinaries worden niet als broncodeback-up meegenomen.


### Eerdere desktop- en packagingstatus — 10 oktober 2026

Electron-GUI-scenario’s onder Linux/Xvfb slaagden afzonderlijk voor SQLite-metadata/herstel/isolation, Monaco BOM/CRLF/undo/tabmodellen, Save As, CSS visual-match/manual shared impact/guarded edit met exacte bronbehoud, snippetgroepen en logfilters. De vorige GUI-run eindigde op 14/20. Een tussentijdse run eindigde op 28/31: twee testproblemen zijn gecorrigeerd (CSS filesystem-polling had een intentional save-gap ENOENT; DOM matcher gebruikte `toHaveText`, dat `<title>` overslaat). De derde bevinding was een echte priority-bug: snel `lower` en `higher` klikwerk kon op stale absolute value 50 rekenen en uitkomen op 51. Backend delta-acties zijn toegevoegd; de daaropvolgende rerun slaagde 31/31 en A-review keurde de priority-/assertionfixes goed. Dit eerdere 28/31-resultaat is historie. Een eerdere cross-compiled Linux-build leverde `release/FTP-Studio-1.0.0-win-x64.zip` op (156 MiB; 6.134 entries, geen Node native addons, vijf Monaco-workers). Die artifact is stale; nieuwe packaging volgt na verificatie van de aanvullende wijzigingen. Windows runtime, DPAPI en signing zijn onbewezen. De twee benchmarkmatrices zijn inmiddels afgerond en staan in docs/BENCHMARKS.md.

## Oplevercheckpoint — 10 oktober 2026, 13:22 UTC

De actuele Windows-ZIP is gedeeld voor de door de gebruiker gevraagde visuele check. Inhoud en integriteit zijn gecontroleerd; geen Windows-uitvoering geclaimd. Broncode, Git-bundle en overdrachtsarchief worden voor dit checkpoint vernieuwd. De gebruiker kan zelfstandig de interface beoordelen terwijl de resterende P0/P1-eisen en Windows-validatie open blijven.

## Downloadherstel en vervolgontwikkeling — 10 oktober 2026

De gebruiker kon de eerdere lokale artifactlink niet downloaden. De volledige ZIP overschreed de 100 MiB-grens van de Google Drive-uploadroute. Twee binaire delen zijn daarom naar het gekoppelde Drive-account geüpload en met metadata-readback gecontroleerd. Hun gezamenlijke SHA-256 is gelijk aan de oorspronkelijke ZIP. De gebruiker heeft bevestigd dat beide downloads werken. Samenvoeginstructies en links staan in [docs/DOWNLOAD.md](docs/DOWNLOAD.md). Het oorspronkelijke Windows-checkpoint blijft ongewijzigd.

Alle voorgaande subagents waren klaar; er was geen nog lopende ontwikkeling of wachtende agent. Voor het vervolg zijn de bestaande contexten `file_columns` (B) en `integration_review` (A) hervat voor virtualisatie van wachtrij en activiteitenlog. De onafhankelijke review vond randgevallen in focusverzoeken en scrollankering bij gewijzigde rijhoogtes; beide zijn hersteld en de finale A-review is akkoord. De hoofdagent heeft typecheck/build, 43/43 volledige desktoptests en daarna 3/3 aangescherpte wachtrijtests succesvol uitgevoerd. De volledige masterprompt blijft open.

## Reparatieversie 1.0.1 — 24 oktober 2026

De gebruiker bevestigde dat mapdownloads na lang wachten toch starten, meldde niet-verwijderbare conflicten en vroeg overdrachten buiten de profielmap. De reparatie omvat zichtbare voorbereiding, 16-itembatches zonder dubbele renderer-statlus, een eigen gevalideerde lokale root per handmatige opdracht, en duurzaam archiveren van conflicten met herstelgegevens.

A-agent `transfer_roots` implementeerde queue/veiligheidsregressies; B-agent `download_tests` schreef echte FTP/Electron-tests; onafhankelijke A-agent `download_review` reviewde code en tests en voegde service-integratiedekking toe. De hoofdagent integreerde renderer/types/service, voerde tests/builds uit en stelde de Windows-ZIP samen. Resultaten: 420/420 volledige backendrun, 3/3 aanvullende servicecases, 51/51 volledige desktoprun. Windows-uitvoering niet beschikbaar.

De 1.0.1-broncode is gepusht naar GitHub. GitHub-binaryupload faalde met HTTP 401 op uploads.github.com; de aangemaakte release blijft een concept zonder assets. Beide Windows-ZIP-delen zijn via Drive geüpload en met metadata-readback gecontroleerd. Zie docs/DOWNLOAD-1.0.1.md voor links en samenvoegen.
