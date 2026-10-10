# FTP Studio — functionele specificatie

**Status:** De huidige build is op Linux gecompileerd en gecontroleerd: **408/408 Vitest-tests in 19 suites (63,29 s)**. De uitgebreide Electron/Xvfb-ronde haalde **38/40**; na herstel van de labels in het vergelijkingsvenster slaagden **alle vijf betreffende scenario’s (20,1 s)**. De overige 35 scenario’s waren geslaagd. Dit is geen nieuwe volledige 40/40-run. Typecheck en applicatiebuild zijn groen. De actuele Windows x64 ZIP is samengesteld en op inhoud, CRC en SHA-256 gecontroleerd; Windows-uitvoering, DPI en DPAPI blijven ongeverifieerd. De volledige masterprompt is nog niet afgerond.

## Doel en doelgroep

FTP Studio is een desktopwerkplek voor webontwikkelaars die lokaal bestanden bewerken, verbinding maken met een webserver en overdrachten vooraf willen controleren. De combinatie is bedoeld om veel dagelijkse taken van een code-editor en FTP/SFTP-client in één venster uit te voeren. De huidige app is een bruikbare basis, geen volledige Dreamweaver- of FileZilla-vervanger.

De primaire interface en meldingen zijn Nederlandstalig. De applicatie is gebouwd met Electron 41, TypeScript, React en Monaco Editor. De projectmetadata noemt Windows x64 ZIP als distributiedoel. Een zelfstandige ZIP wordt op Linux cross-gecompileerd; runtimevalidatie vereist Windows. De oorspronkelijke P0- en P1-eisen blijven de acceptatiebasis; onderstaande ontbrekende functies zijn open werk, geen overeengekomen scopeverlaging.

## Huidige mogelijkheden

- Meerdere projecten met lokale hoofdmap, serverhoofdmap, standaardverbinding, filters, publicatieomgevingen en optionele lokale preview-URL.
- Opgeslagen FTP-, expliciete FTPS-, impliciete FTPS- en SFTP-profielen. FTP is onversleuteld; gebruik dit alleen op een vertrouwd netwerk. FTP gebruikt passieve modus waar geconfigureerd.
- SFTP vereist een vooraf opgegeven SHA-256-hostvingerafdruk. De vingerafdruk moet via een onafhankelijke, vertrouwde bron worden gecontroleerd. De app accepteert geen onbekende sleutel als automatische trust-on-first-use.
- Lokale en externe bestandspanelen met navigatie, filters, verborgen-bestandeninstelling en optioneel gekoppelde navigatie. Remote gewone bestanden aanmaken/kopiëren is endpointgebonden, gebruikt staging en filters, weigert aanwezige doelen en ruimt geregistreerde caches gecontroleerd op.
- Monaco-code-editor met openen, opslaan, meerdere tabs, herstelgegevens, zoeken/vervangen in het project, snippets en gerelateerde statische assets.
- Beperkt visueel bewerken van statische HTML en CSS. Wijzigingen worden op bronposities toegepast. Bij ongeldige of dynamische inhoud wordt visueel bewerken geblokkeerd en blijft de broncode beschikbaar in de code-editor.
- Preview in een ingestelde localhost/loopback-URL. Zonder ingestelde URL is er geen PHP-runtime. Dynamische PHP- en templatebestanden tonen in de ingebouwde voorbeeldweergave een uitleg-placeholder; PHP wordt nooit automatisch uitgevoerd.
- Overdrachtswachtrij voor bestand- en mapoverdracht, voortgang, pauzeren, hervatten, annuleren, opnieuw proberen en prioriteit. Wachtrijgegevens zijn persistent. Een hervatte of opnieuw gestarte overdracht begint bij byte nul; veilig hervatten vanaf een byte-offset is niet ondersteund.
- Staging, verificatie en rollback-snapshot rond overdrachten waar de serverprotocollen dat toelaten. Er wordt geen claim gedaan dat alle servers dezelfde atomaire garanties bieden.
- Publicatieplan met vergelijking van lokale en externe bestanden, filters, optionele statische afhankelijkheden, conflictregels en expliciete bevestiging voor gemarkeerde productieomgevingen. Alleen geselecteerde, veilige planitems gaan naar de wachtrij. Dit is geen continue tweerichtingssync.
- Lokale en externe bestandsbewerkingen, met bevestiging voor destructieve verwijderingen. Externe bestanden worden niet automatisch verwijderd door publicatie of synchronisatie.
- SQLite-opslag in Electron userData met incrementeel duurzaam transferjournal en globale timer voor normale UI-snapshotbundeling (clear/close flushen direct; geen harde latencygrens). Aanmeldgegevens worden versleuteld via Electron safeStorage; op Windows gebruikt Electron de beschikbare systeemintegratie (DPAPI). Als veilige opslag niet beschikbaar is, worden credentials niet persistent opgeslagen.

## Grenzen en niet-beschikbare onderdelen

- Geen volledige vrije pagina-opmaak zoals een drag-and-drop page builder of complete Dreamweaver-site designer.
- Geen PHP-uitvoering, PHP-debugger, databasebeheer, serverbeheer of automatisch PHP-pakketbeheer. Statische letterlijke includes worden wel gedetecteerd; dynamische includes worden niet opgelost.
- Geen automatische host-keyregistratie, blind vertrouwen op een waargenomen SSH-key of automatische TLS-certificaatomzeiling.
- Geen byte-offset-resume na onderbreking. Hervatten start het bestand opnieuw en controleert of bron/doel sinds de planning veranderde.
- Geen bewezen compatibiliteit/performance met alle hostingproviders, grote projecten, netwerkshares of Windows-versies.
- Geen releasehandtekening of installer. De zelfstandige `release/FTP-Studio-1.0.0-win-x64.zip` is een Linux-cross-build; dit is geen Windows-runtimevalidatie.

## Veilige overdrachtsregels

Padtoegang blijft binnen de ingestelde project-/verbindingsroots. Symlinks, padontsnapping en onveilige bestandsnamen worden geweigerd. Veelvoorkomende geheimen (`.env`, SSH-sleutels, credentials, certificaat-/keybestanden en vergelijkbare namen) en ontwikkelmappen zoals `.git` en `node_modules` zijn standaard uitgesloten van bulkoverdracht/publicatie. De wachtrij valideert overdrachten opnieuw. Conflict, ontbrekende betrouwbare metadata of wijziging sinds de planning vraagt om handmatige controle in plaats van stil overschrijven.

Automatisch uploaden na lokaal opslaan is optioneel en gebruikt dezelfde conflictcontroles en wachtrij. Schakel deze instelling bewust in en gebruik haar alleen met een gecontroleerde actieve verbinding.

## Technische acceptatie voor een release

Een release is pas klaar nadat dependency-installatie, typecheck, tests en Windows x64 packaging op de bedoelde Windows-omgeving zijn uitgevoerd en de resultaten/artifacts zijn vastgelegd. Zie [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) en [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Dekking van de oorspronkelijke P0/P1-opdracht

Brondekking bijgewerkt op 10 oktober 2026. **Bron aanwezig** betekent een bereikbare implementatie; daadwerkelijke verificatie staat in TESTRESULTS.md. De oorspronkelijke eisen blijven leidend; open punten zijn geen overeengekomen scopeverlaging.

| Prioriteit en eis | Stand van de bron en resterende dekking | Bewijsplaats |
|---|---|---|
| P0 — Nederlandse moderne Windows-desktop | Bron en geselecteerde bediening onder Linux/Xvfb gecontroleerd; Windows-uitvoering en DPI-validatie blijven open. | `src/renderer/App.tsx`, `styles.css`, `src/main/main.ts` |
| P0 — lokale/externe bestandslijsten met type, grootte, datum+tijd, multi-select, sorteren, verborgen items, contextmenu, zoeken, virtualisatie | Bron aanwezig, inclusief vaste rijhoogte en begrensd gerenderd venster; GUI-controles met 1.200 echte bestanden en begrensde DOM-rijen uitgevoerd. | `FilePane.tsx`, `utils.ts`, `App.tsx` |
| P0 — CRUD, kopiëren/verplaatsen, drag-and-drop | Deels: lokaal aanmaken/kopiëren/verplaatsen en intern cross-pane drag-and-drop. Remote reguliere bestanden aanmaken en kopiëren zijn toegevoegd met staging, endpointbinding, filters, absent-target-guard en geregistreerde cache-opruiming. Remote verplaatsen en open/dirty-documentbescherming zijn in Electron getest. Remote kopiëren van volledige mappen en externe OS-drop ontbreken. | `FilePane.tsx`, `App.tsx:fileAction`, `service.ts:mutateRemote` |
| P0 — FTP, expliciete/impliciete FTPS, SFTP, wachtwoord/SSH-key | Adapters en profielvelden aanwezig; lokale protocolfixtures zijn uitgevoerd in de volledige Vitest-suite. Provider- en Windowsvalidatie ontbreken. | `src/main/remote.ts`, `ProfileDialog.tsx` |
| P0 — profiel-CRUD, groepen, verbindingstest, quickconnect | Deels: CRUD/dupliceren, profielgroepen, verbindingstest en directe eenmalige quickconnect zonder opslaan zijn aanwezig. | `ProfileDialog.tsx`, `QuickConnect.tsx`, `App.tsx` |
| P0 — bookmarks, meerdere servers met eigen paden | Bron aanwezig: padparen en in-memory padstaat per verbinding+endpoint. Wissels verbergen verouderde rijen. Herstel van alle verbindingspaden na herstart niet aangetoond. | `App.tsx:connectionViews`, `remoteContext` |
| P0 — bestanden/volledige mappen overdragen, standaard vier sessies, navigatie en totaalgrens één | Bron aanwezig; sessieleases, queue en lokale protocolfixtures zijn getest. Twee loopback-FTP-matrices van 16 scenario’s elk zijn afgerond met 8.128 SHA-256-controles; resultaten en grenzen in `docs/BENCHMARKS.md`. | `remote.ts`, `queue.ts`, `queue.test.ts` |
| P0 — duurzame queue, voortgang/snelheid/ETA/prioriteit, pause/resume/cancel/retry/clear | Bron aanwezig. Herstart pauzeert werk; hervatten begint opnieuw. Maximaal vier automatische pogingen totaal, dus drie retries; handmatige retry start een nieuwe reeks. Onopgeloste hersteltransacties blijven bewaard bij clear. | `queue.ts`, `QueuePanel.tsx` |
| P0 — gekoppelde navigatie beide kanten, rootgrenzen, ontbrekende map niet aanmaken | Mapping en begrenzing aanwezig; een ontbrekende tegenmap geeft een lijstfout en wordt niet automatisch gemaakt. Echte Electron/FTP-test voor beide richtingen en ontbrekende mappen geslaagd. | `App.tsx:navigate`, `core/browserWorkspace.ts` |
| P0 — conservatieve metadata-vergelijking | Bron aanwezig; ontbrekende betrouwbare metadata geeft onzeker/conflict. Grootte+tijd zijn geen inhoudsbewijs en sluiten gelijktijdige serverwijzigingen niet volledig uit. | `core/browserWorkspace.ts`, `queue.ts` |
| P0 — afzonderlijke display/transfer/sync-filters, naam/extensie/pad/map/grootte/datum, glob/regex, profielen | Deels: afzonderlijke projectregels en benoemde, onafhankelijke filterprofielen met snapshots aanwezig; regex is een begrensde subset. Standaard ontwikkelmapuitsluitingen en gevoelige-padcontrole aanwezig. | `ProjectDialog.tsx`, `core/browserWorkspace.ts`, `service.ts` |
| P0 — Monaco HTML/PHP/CSS/JS/JSON/XML/SQL/MD/TXT, completion/folding/format/find/undo | Taalregistratie, Monaco-basisfuncties en HTML/CSS/JSON/TS-workers aanwezig. Geen bewijs dat formattering/completion voor elke gevraagde taal beschikbaar is; PHP/XML/SQL hebben geen eigen taalserver/formatterimplementatie. | `CodeEditor.tsx`, `scripts/build.mjs` |
| P0 — BOM/EOL, dirty, recovery, tabs | UTF-8 BOM- en CRLF-behoud, documentmodellen/undo/view en herstelopslag zijn aanwezig; afzonderlijke Monaco GUI-controles slaagden onder Linux/Xvfb. Crashherstel op Windows blijft open. | `CodeEditor.tsx`, `App.tsx`, `service.ts` |
| P0 — remote cache-edit, originele metadata, conflictdiff, Save As/upload/auto-upload standaard uit | Deels: endpointgebonden cache, snapshots, Save As en bewaakte upload aanwezig. Alleen-lezen visuele diff haalt de actuele schijf/serverversie op en vergelijkt die met de editorbuffer; vijf echte desktopscenario’s slagen. Geen automatische merge of herautorisatie van een conflicterende upload. | `App.tsx`, `service.ts`, `shared/contracts.ts` |
| P0 — credentials/TLS/SSH/padbeveiliging/geïsoleerde bridge | Beveiligingsgrenzen geïmplementeerd; lokale protocoltests en geselecteerde Electron-scenario’s uitgevoerd. Providercompatibiliteit en Windows/DPAPI blijven open; exacte GUI-dekking staat in TESTRESULTS.md. | `remote.ts`, `storage.ts`, `main.ts`, `preload.ts`, `security.test.ts` |
| P0 — project-CRUD, recent, tabs herstellen, instellingen | Deels: CRUD, laatste actieve project, lokale open bestanden en instellingen aanwezig. Expliciete recent-projecthistorie/-volgorde ontbreekt. | `App.tsx`, `ProjectDialog.tsx`, `service.ts` |
| P1 — exacte statische HTML/source-selectie beide kanten | Bron aanwezig met bronoffsets/revisiecontrole; DOM-drag is gebonden aan document en bronhash. Parser-suite en DOM/bronselectiescenario’s zijn onder Linux/Xvfb uitgevoerd en geslaagd. | `core/source.ts`, `EditorPane.tsx` |
| P1 — CSS-navigatie inline/intern/extern; selectors/classes/cascade/specificiteit/overerving/media/herkomst | Deels: inline bewerking en handmatig externe CSS-regels openen/bewerken. Gematchte selectors voor het geselecteerde element en navigatie naar bronnen aanwezig. Volledige cascade, overerving, computed winning property en property provenance ontbreken. | `EditorPane.tsx`, `core/source.ts` |
| P1 — externe CSS visueel wijzigen met gedeelde-selectorimpact en frameworkbehoud | Deels: gerichte externe CSS-bronpatches; gedeelde-selectorimpact wordt handmatig getoond; bewerken vereist expliciete bevestiging. Frameworkcompatibiliteit niet bewezen. | `EditorPane.tsx`, `core/source.ts` |
| P1 — PHP/templates/scripts behouden; onveilige visuele edits weigeren | Blokkerende bronanalyse en beperkte patches aanwezig; parserregressies slagen in de volledige Vitest-suite. Optionele afzonderlijke pagebuilder niet geïmplementeerd. | `core/source.ts`, `source.test.ts` |
| P1 — WYSIWYG tekst/headings/link/img/table/form/button/container/columns/nav/Flex/Grid | Deels: statische blokken invoegen en attributen/tekst bewerken aanwezig. Geen complete canvasgestuurde layout-/resize-/drag-and-dropbewerking van al deze elementen. | `BlockPalette.tsx`, `EditorPane.tsx` |
| P1 — DOM tree/select/attrs/duplicate/remove/move/drag | Boom, selectie en acties voor veilige statische nodes aanwezig; inklappen, toetsenbordbediening en slepen zijn geïmplementeerd. Dynamische bron wordt geweigerd; DOM-scenario’s voor boomselectie, bronkoppeling, slepen, undo en exact BOM/CRLF-behoud slaagden. | `EditorPane.tsx`, `core/source.ts` |
| P1 — code/visual/split/preview, responsive, relatieve assets, JS, default/Edge/Chrome | Deels: vier modi/breedtes/assetinlining en standaardbrowser aanwezig. Ingebouwde preview schakelt projectscripts expliciet uit. Browserkeuze voor standaard, Edge en Chrome zit in de editor; specifiek Edge/Chrome starten is alleen op Windows ondersteund en nog niet gevalideerd. Externe statische preview kan JS uitvoeren. | `EditorPane.tsx`, `renderer/preview.ts`, `main/preview.ts`, `service.ts` |
| P1 — optionele zelf ingestelde PHP-server, nooit automatisch starten | Loopback-URL-configuratie aanwezig; app start/installeert geen PHP. Dynamische bron blijft uit interne preview. | `ProjectDialog.tsx`, `main/preview.ts` |
| P1 — gerelateerde HTML/CSS/JS/images/imports/urls/statische PHP includes en dependency-publicatiepreview | Deels: beperkte statische dependencydetectie en publicatieoptie aanwezig. Letterlijke statische PHP-includes worden gedetecteerd; URL-verwijzingen blijven apart en bekende gevoelige paden worden uitgesloten. Dynamische includes blijven buiten bereik. | `core/phpDependencies.ts`, `core/publishing.ts`, `service.ts:relatedFiles`, `PublishDialog.tsx` |
| P1 — project search/replace, regex, vooraf diff/selectie | Bron aanwezig met preview en bronhashcontrole; regex is een veilige subset, geen volledige JavaScript-regex. | `SearchDialog.tsx`, `core/workspace.ts` |
| P1 — snippets CRUD/search/groepen | Deels: Zoeken en groepen aanwezig naast CRUD. | `SnippetsDialog.tsx` |
| P1 — manifest/hashes dev/staging/prod, productiebevestiging, conflictplan, upload/download/beide, geen autodelete | Bron aanwezig met configureerbare omgevingen, endpointgebonden manifest en geverifieerde completions. Geen globale atomaire deploymentgarantie. | `core/publishing.ts`, `PublishDialog.tsx`, `service.ts` |
| P1 — recursive remote metadata search/cancel/result open/download/edit/rename/navigate | Implementatie en servicebediening aanwezig. Filters op naam/pad/type/grootte/datum; geen inhoudsdownload bij zoeken. Downloads uit resultaten weigeren bestaande doelbestanden, ook recursief. Unit-tests slagen; volledige GUI-run nog open. | `main/remoteSearch.ts`, `SearchDialog.tsx`, `service.ts` |
| P1 — alleen bewezen veilige offset-resume, anders restart | Veilige restart-keuze aanwezig; geen byte-offset-resume geïmplementeerd of geclaimd. | `queue.ts`, `remote.ts` |
| P1 — chmod numeriek+checkboxes, recursief met bevestiging | Deels: Unix-checkboxes en octale invoer aanwezig; recursie is een expliciete keuze met bevestiging. | `App.tsx:fileAction`, `service.ts:mutateRemote` |
| P1 — gedetailleerde logs, niveau-filter, zoekveld, geen secrets | Logniveau-, tekst- en verbindingsfilters en geheimredactie aanwezig. Wachtrijprioriteit heeft afzonderlijke verhogen/verlagen-bediening. | `QueuePanel.tsx`, `service.ts:log`, `remote.ts` |
| Oplevering — portable Windows EXE/ZIP, bron/build/instructies, echte 1/2/4/8- en duizendenbestandmetingen | Bron, scripts en instructies aanwezig. Zelfstandige Windows ZIP cross-build; niet op Windows uitgevoerd. Beide benchmarkmatrices van 16 scenario’s zijn afgerond; zie `docs/BENCHMARKS.md` voor meetgrenzen. | `package.json`, `scripts/benchmark-transfers.mts`, `TESTRESULTS.md` |

Componentnamen zonder pad staan onder `src/renderer/components`; `service.ts`, `queue.ts`, `remote.ts` staan onder `src/main`.

## Integriteitsgrenzen

Lokale vervanging vereist hardlinks op hetzelfde bestandssysteem. Een mislukte hardlinkproef weigert de wijziging voordat het origineel wordt verplaatst. FAT/exFAT/netwerkshares zijn hiermee niet algemeen ondersteund of gevalideerd. De code bewaart POSIX-modebits en een oorspronkelijke reservekopie; behoud van Windows-ACL's, eigenaar, alternate data streams of andere uitgebreide metadata wordt niet gegarandeerd.

FTP/SFTP bieden in deze adapters geen generieke conditionele rename met server-side compare-and-swap. Snapshotcontroles, staging en backups verkleinen de kans op onopgemerkte wijziging, maar een externe schrijver met dezelfde grootte/tijdstempel of een wijziging tussen laatste controle en rename blijft een protocolgrens. Lokale hashes zijn geen bewijs van gelijke serverinhoud zonder geverifieerde remote hash. Deze grenzen moeten bij acceptatie worden beoordeeld.

## Laatste afgeronde aanvullingen

Alleen-lezen Monaco-diff vergelijkt uw vastgelegde editorbuffer met een verse schijf/servermomentopname, zonder uploadbasis of hersteltekst te vervangen. Vijf echte desktopscenario’s slagen. Bestandskolommen zijn per paneel instelbaar en opgeslagen; code/canvasverdeling is persistent met veilige annulering. Drie kolomscenario’s en een split-lifecycle-scenario slagen onder Electron/Xvfb.
