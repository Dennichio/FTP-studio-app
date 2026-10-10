# Voortgang

## Huidige stand

**Laatste update 10 oktober 2026:** expliciete netwerkgoedkeuring is in deze bestaande omgeving geslaagd (registry HTTP 200). Alle npm-dependencies en de officiële Electron-runtime zijn nu geïnstalleerd; package-lock.json is aangemaakt. Typecheck en applicatiebuild slagen na gerichte compatibiliteitsreparaties. Eerdere netwerkblokkades hieronder zijn historie. Na herstel van drie gevonden testfixtureproblemen slaagt de volledige Vitest-reeks: 173/173. Windows-validatie en productfunctionaliteit blijven open.

De repository bevat een Electron/TypeScript/React-app met Monaco, remote profielen en protocols, twee bestandspanelen, projectbeheer, editor, bronbewuste beperkte HTML/CSS-inspector, lokale preview, persistentie, queue en publicatieplan. De broncode en tests zijn aanwezig.

**Historische blokkade vóór de expliciete goedkeuring (inmiddels deels opgelost):** dependency-installatie, `npm run typecheck`, `npm test`, Windows x64-build, starten op Windows, protocoltests tegen echte serverconfiguraties, onderbreking/crashherstel op Windows, safeStorage/DPAPI-gedrag op doelversies, installer/artifact en releasekwaliteit. Shell-netwerktoegang blokkeerde de volledige dependency-installatie. Deze toenmalige beperking is voor Linux-build en protocoltests opgelost; Windowsresultaten blijven onbewezen.

De hoofdagent heeft de meegeleverde offline-controles uitgevoerd: aanvankelijk 31/31 en na de queue-uitbreidingen 39/39 wachtrijtestgevallen via Node assert, plus 5/5 kerncontroles via node:test, 7/7 metadata-searchchecks en 10/10 managerchecks met geïnjecteerde sessies. Dit zijn geen Vitest-run of Windows-validatie. Exacte dekking en beperkingen staan in [TESTRESULTS.md](TESTRESULTS.md).

## Werkverdeling zoals opgegeven

- Model A (Astra): overdrachtsintegriteit, bronpatches en onafhankelijke beveiligingsreview.
- Model B (GPT-6.1-Sol): UI, remote verbindingen en workspace.
- Model C (GPT-6-Luna): deze documentatie.
- Hoofdagent: integratie en beschikbare verificatie.

De verdeling geeft taaktoewijzing weer en is geen onafhankelijke kwaliteitscertificering. De C-documentatie is daarna door de A-reviewer bijgewerkt aan de hand van concrete brondekking. Hoofdagent moet wijzigingen/reviews en resultaten bij release aanvullen.

## Volgende releaseblokkades

1. Voltooid: npm-dependencies, lockfile en Electron-runtime geïnstalleerd via expliciete netwerkgoedkeuring. Gebruik `npm ci` voor volgende installaties.
2. Voltooid: typecheck, build en 173 Vitest-tests. Desktopbediening en crashherstel moeten nog in Electron worden uitgevoerd.
3. Op Windows x64 bouwen (`npm run dist:win`), artifact starten en releasechecklist doorlopen.
4. Reële provider-/servervarianten valideren, inclusief SSH fingerprint, TLS, conflict, stagingrollback en crash/herstart.
5. Resultaten, bekende beperkingen en artifactlocatie in dit bestand en `TESTRESULTS.md` documenteren.

Naast deze uitvoeringsblokkades is er functioneel open werk. De oorspronkelijke P0/P1-opdracht is niet compleet door alleen dependencies te installeren of tests te laten slagen. De volledige dekkingsmatrix staat in [SPECIFICATION.md](SPECIFICATION.md): onder meer remote copy/move/create-file, directe quickconnect, profielgroepen/testactie, benoemde filterprofielen, remote conflictdiff, geavanceerde CSS-cascade/herkomst/selectorimpact, canvaslayoutbewerking, interne JS-preview, browserkeuze, statische PHP-includes, snippetgroepen/zoeken, chmod-checkboxes/recursieve bediening en logniveaufilter ontbreken geheel of gedeeltelijk.

## Scope- en statusregel

Dit project bevat een geïntegreerde broncodebasis, maar de beloofde complete Dreamweaver+FileZilla-ervaring is nog niet gerealiseerd of als desktopapp geverifieerd. Zie [SPECIFICATION.md](SPECIFICATION.md) voor grenzen en [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) voor status per eis.

## Uitgevoerde onafhankelijke reviews

GPT-6 Astra controleerde de B-modelcode voor UI, protocollen en werkruimtediensten; een afzonderlijke Astra-agent controleerde ook opslag, preview, desktopbrug en documentatie van GPT-6 Luna. Gevonden fouten rond uploadbestemming, verouderde synchronisatiemanifesten, onveilige bestandswissels, geheime foutteksten, groeiende downloadstreams en speciale bestanden zijn hersteld of in regressietests opgenomen. Nieuwe desktopcode en protocoltests blijven afhankelijk van de ontbrekende volledige build/testcontrole. Twee subagents stopten later wegens een gemelde modelgebruikslimiet; de hoofdagent nam hun resterende integratie over.

### Aanvullende integratiereview op 9 oktober 2026

Na die eerdere onderbreking is de A-review hervat. De review omvat renderer, bronpatches, main/preload/storage/preview/service en de overdrachtsintegratie; de queue-reviewer beoordeelt daarnaast protocollen, workspace en publiceren. Dit is een afgebakende statische review plus de expliciet vermelde offlinecontroles, geen certificering van alle paden.

Nieuw gecontroleerde integratie bevat een gedeelde endpointidentiteit voor profielen, verzoeken en remote caches; controle vóór en na sessieacquisitie; snapshots uit de voltooide transfer in plaats van een latere serverstat; geen baselinevernieuwing voor een andere lokale cache; coalescing van gelijktijdig openen van hetzelfde remote document; vaste bronrevisie bij DOM-drag; behoud van BOM en CSS-`!important`; per-verbindingpadstaat en contextgebonden, gevirtualiseerde bestandsrijen. Save As is nu bereikbaar. Remote metadata-search en resultaatbediening zijn toegevoegd en moeten nog door de volledige runner/desktop worden gecontroleerd.

De A-review meldde ook dat downloaden uit zoekresultaten zonder expliciete bescherming bestaande lokale bestanden kon vervangen. De integratie bevat nu een nooit-overschrijvenoptie, inclusief recursieve kinderen; de hoofdagent rapporteerde 39/39 offline queuegevallen na deze en de modebehoudwijzigingen. De aanvullende statische review van remoteSearch, Save As, workspace-opruimfouten en deze queuedelta's vond geen nieuwe ernstige fout. Dit is reviewhistorie, geen claim van een geslaagde desktoptest. Na de eerder gemelde ontbrekende bestandspaneel-drag-and-drop is interne cross-pane transferdrag toegevoegd en statisch gereviewd: eenmalig intern token, vaste paneel-/endpointcontext, afwijzen van stale/same-pane/linkdrops en hergebruik van de bewaakte transferactie. Externe OS-drag/drop is niet geïmplementeerd. Dit staat los van DOM-drag in de editor.

Lokale hardlinktransacties vereisen ondersteuning van het bestandssysteem en garanderen geen Windows-ACL/ADS-behoud. Remote metadata plus staging bieden geen server-side compare-and-swap. De queue doet maximaal vier pogingen totaal (drie automatische retries), niet vier retries. Deze grenzen staan ook in architectuur en specificatie.

## Hercontrole en checkpoint — 10 oktober 2026

De voorafgaande netwerktoegangsaanvraag voor `npm install --ignore-scripts` leverde geen installatie-uitvoer op en is na langdurig wachten afgebroken. Tijdens die geblokkeerde toolaanroep werkte de hoofdagent niet verder. Na hervatting waren de oude subagents niet meer live; hun bestanden waren behouden. Een nieuwe GPT-6 Astra-agent (`final_integrity_review`, high) heeft de laatste opslag- en rendererwijzigingen onafhankelijk beoordeeld.

Die review vond een late POSIX-rechtenrace. De hoofdagent houdt nu de staginghandle vast tot na de laatste controle. Een gedetecteerde rechtenwijziging van het oorspronkelijke inode leidt tot een fout en beperking van uitsluitend het eigen staginginode; een inmiddels vervangen doelpad wordt niet aangeraakt. Twee regressies reproduceren zowel deze race als een ander proces dat het doelpad vervangt. De reviewer heeft de reparatie goedgekeurd en de vijf rechtencontroles en vijf kerncontroles opnieuw uitgevoerd. Een wijziging ná de laatste controle blijft een niet-atomaire grens; Windows-ACL/ownership/attributen zijn niet geverifieerd.

De hoofdagent heeft opnieuw 5 kern-, 39 wachtrij-, 7 metadatazoek-, 10 sessiemanager- en uiteindelijk 5 POSIX-rechtencontroles uitgevoerd: alle geslaagd. De broncode is een ontwikkelcheckpoint; volledige compilatie, desktopvalidatie en verdere P0/P1-afwerking blijven open. Er wordt geen uitvoerbaar Windows-product opgeleverd of als gereed aangemerkt.

## Geslaagde netwerkroute en volledige bouw-/unitcontrole

De root-agent gebruikte de beschikbare `exec_command` met expliciete `require_escalated`-goedkeuring voor één begrensde HTTPS-proef. De registry gaf HTTP 200. Vervolgens zijn alle 367 opgeloste pakketten geïnstalleerd met `--ignore-scripts`; de lockfile ligt vast. De officiële Electron 41.10.7-runtime is apart via de ingestelde proxy en ingebouwde checksumcontrole opgehaald. Een nieuwe cloudomgeving is voor deze downloads niet nodig.

De eerste echte compilatie vond ontbrekende `.js`-suffixen in Monaco-imports, een discriminant/typeprobleem in de source-engine en verouderde SFTP-typebeschrijvingen. De eerste bronparsertests vonden daarnaast CSS-offsetfouten en onvoldoende weigering van onbetrouwbare HTML-bronranges. Die fouten zijn gericht gerepareerd. Het B-model `protocol_build_fixes` verzorgde de protocolcompatibiliteit en testfixtures; A-model `source_build_fixes` herstelde de parser en reviewde de protocolwijzigingen onafhankelijk. De hoofdagent controleerde de brondelta en integreerde de renderer- en fixturecorrecties.

Laatste feitelijke resultaten: `npm run typecheck` exit 0, `npm run build` exit 0, `timeout 180s npm test` met goedgekeurde lokale sockets exit 0 en **173/173 tests in acht suites**. De suite gebruikt ook echte FTP-/SFTP-sockets en FTPS-certificaatweigering. Correcties in fixtures betroffen een geldig versleuteld PKCS1-sleutelformaat, correcte Unix-longnames en expliciete POSIX-testrechten; productiebeveiligingscontroles zijn niet versoepeld.

De applicatie is hiermee nog niet releaseklaar. De Electron-GUI/e2e, Windows-build en Windows-runtimevalidatie zijn niet uitgevoerd en de overige functionele gaten in de P0/P1-matrix blijven open. De broncode, lockfile en geschiedenis zijn opnieuw verpakt voor overdracht; geïnstalleerde node_modules en platformbinaries worden niet als broncodeback-up meegenomen.
