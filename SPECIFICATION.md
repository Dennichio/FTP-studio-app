# FTP Studio — functionele specificatie

**Status:** beschrijving van de huidige broncode, versie 1.0.0. Dit document is geen bewijs van een afgerond of gevalideerd Windows-product. Windows-build, installer/ZIP-artifact, typecheck en Vitest-resultaten zijn nog niet beschikbaar; dependency-installatie werd geblokkeerd door ontbrekende shell-netwerktoegang.

## Doel en doelgroep

FTP Studio is een desktopwerkplek voor webontwikkelaars die lokaal bestanden bewerken, verbinding maken met een webserver en overdrachten vooraf willen controleren. De combinatie is bedoeld om veel dagelijkse taken van een code-editor en FTP/SFTP-client in één venster uit te voeren. De huidige app is een bruikbare basis, geen volledige Dreamweaver- of FileZilla-vervanger.

De primaire interface en meldingen zijn Nederlandstalig. De applicatie is gebouwd met Electron 41, TypeScript, React en Monaco Editor. De projectmetadata noemt Windows x64 ZIP als distributiedoel. Een Windows-build is nog niet aangetoond. De oorspronkelijke P0- en P1-eisen blijven de acceptatiebasis; onderstaande ontbrekende functies zijn open werk, geen overeengekomen scopeverlaging.

## Huidige mogelijkheden

- Meerdere projecten met lokale hoofdmap, serverhoofdmap, standaardverbinding, filters, publicatieomgevingen en optionele lokale preview-URL.
- Opgeslagen FTP-, expliciete FTPS-, impliciete FTPS- en SFTP-profielen. FTP is onversleuteld; gebruik dit alleen op een vertrouwd netwerk. FTP gebruikt passieve modus waar geconfigureerd.
- SFTP vereist een vooraf opgegeven SHA-256-hostvingerafdruk. De vingerafdruk moet via een onafhankelijke, vertrouwde bron worden gecontroleerd. De app accepteert geen onbekende sleutel als automatische trust-on-first-use.
- Lokale en externe bestandspanelen met navigatie, filters, verborgen-bestandeninstelling en optioneel gekoppelde navigatie.
- Monaco-code-editor met openen, opslaan, meerdere tabs, herstelgegevens, zoeken/vervangen in het project, snippets en gerelateerde statische assets.
- Beperkt visueel bewerken van statische HTML en CSS. Wijzigingen worden op bronposities toegepast. Bij ongeldige of dynamische inhoud wordt visueel bewerken geblokkeerd en blijft de broncode beschikbaar in de code-editor.
- Preview in een ingestelde localhost/loopback-URL. Zonder ingestelde URL is er geen PHP-runtime. Dynamische PHP- en templatebestanden tonen in de ingebouwde voorbeeldweergave een uitleg-placeholder; PHP wordt nooit automatisch uitgevoerd.
- Overdrachtswachtrij voor bestand- en mapoverdracht, voortgang, pauzeren, hervatten, annuleren, opnieuw proberen en prioriteit. Wachtrijgegevens zijn persistent. Een hervatte of opnieuw gestarte overdracht begint bij byte nul; veilig hervatten vanaf een byte-offset is niet ondersteund.
- Staging, verificatie en rollback-snapshot rond overdrachten waar de serverprotocollen dat toelaten. Er wordt geen claim gedaan dat alle servers dezelfde atomaire garanties bieden.
- Publicatieplan met vergelijking van lokale en externe bestanden, filters, optionele statische afhankelijkheden, conflictregels en expliciete bevestiging voor gemarkeerde productieomgevingen. Alleen geselecteerde, veilige planitems gaan naar de wachtrij. Dit is geen continue tweerichtingssync.
- Lokale en externe bestandsbewerkingen, met bevestiging voor destructieve verwijderingen. Externe bestanden worden niet automatisch verwijderd door publicatie of synchronisatie.
- SQLite-opslag in Electron userData. Aanmeldgegevens worden versleuteld via Electron safeStorage; op Windows gebruikt Electron de beschikbare systeemintegratie (DPAPI). Als veilige opslag niet beschikbaar is, worden credentials niet persistent opgeslagen.

## Grenzen en niet-beschikbare onderdelen

- Geen volledige vrije pagina-opmaak zoals een drag-and-drop page builder of complete Dreamweaver-site designer.
- Geen PHP-uitvoering, PHP-debugger, databasebeheer, serverbeheer of automatische installatie/afhandeling van PHP-afhankelijkheden.
- Geen automatische host-keyregistratie, blind vertrouwen op een waargenomen SSH-key of automatische TLS-certificaatomzeiling.
- Geen byte-offset-resume na onderbreking. Hervatten start het bestand opnieuw en controleert of bron/doel sinds de planning veranderde.
- Geen bewezen compatibiliteit/performance met alle hostingproviders, grote projecten, netwerkshares of Windows-versies.
- Geen releasehandtekening of installer. `dist:win` is ingesteld op een x64 ZIP-target; de artifact is nog niet gebouwd of gecontroleerd.

## Veilige overdrachtsregels

Padtoegang blijft binnen de ingestelde project-/verbindingsroots. Symlinks, padontsnapping en onveilige bestandsnamen worden geweigerd. Veelvoorkomende geheimen (`.env`, SSH-sleutels, credentials, certificaat-/keybestanden en vergelijkbare namen) en ontwikkelmappen zoals `.git` en `node_modules` zijn standaard uitgesloten van bulkoverdracht/publicatie. De wachtrij valideert overdrachten opnieuw. Conflict, ontbrekende betrouwbare metadata of wijziging sinds de planning vraagt om handmatige controle in plaats van stil overschrijven.

Automatisch uploaden na lokaal opslaan is optioneel en gebruikt dezelfde conflictcontroles en wachtrij. Schakel deze instelling bewust in en gebruik haar alleen met een gecontroleerde actieve verbinding.

## Technische acceptatie voor een release

Een release is pas klaar nadat dependency-installatie, typecheck, tests en Windows x64 packaging op de bedoelde Windows-omgeving zijn uitgevoerd en de resultaten/artifacts zijn vastgelegd. Zie [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) en [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Dekking van de oorspronkelijke P0/P1-opdracht

Momentopname van de onafhankelijke bronreview op 9 oktober 2026. **Bron aanwezig** betekent dat een bereikbare implementatie is gevonden, niet dat de functie met Electron of op Windows is bewezen. **Deels** noemt concreet resterend werk. Geen rij heft de vereiste integratie-, beveiligings- of Windowsvalidatie op. Wijzigingen na deze momentopname vereisen hercontrole.

| Prioriteit en eis | Stand van de bron en resterende dekking | Bewijsplaats |
|---|---|---|
| P0 — Nederlandse moderne Windows-desktop | Bron aanwezig; uiterlijk, bediening, DPI en executable niet uitgevoerd/gevalideerd. | `src/renderer/App.tsx`, `styles.css`, `src/main/main.ts` |
| P0 — lokale/externe bestandslijsten met type, grootte, datum+tijd, multi-select, sorteren, verborgen items, contextmenu, zoeken, virtualisatie | Bron aanwezig, inclusief vaste rijhoogte en begrensd gerenderd venster; geen meting met duizenden echte bestanden in Electron. | `FilePane.tsx`, `utils.ts`, `App.tsx` |
| P0 — CRUD, kopiëren/verplaatsen, drag-and-drop | Deels: lokaal aanmaken/kopiëren/verplaatsen, beide kanten map/rename/delete en transferknoppen. Interne cross-pane drag-and-drop is toegevoegd met eenmalig token, vastgelegde endpoint/padcontext en dezelfde guarded transferflow. Externe OS-drop ontbreekt. Extern nieuw bestand en algemeen serverzijdig kopiëren/verplaatsen hebben geen bereikbare UI-flow. | `FilePane.tsx`, `App.tsx:fileAction`, `service.ts:mutateRemote` |
| P0 — FTP, expliciete/impliciete FTPS, SFTP, wachtwoord/SSH-key | Adapters en profielvelden aanwezig; echte protocoltests voorbereid maar niet uitgevoerd. | `src/main/remote.ts`, `ProfileDialog.tsx` |
| P0 — profiel-CRUD, groepen, verbindingstest, quickconnect | Deels: CRUD/dupliceren, opgeslagen-profielselectie en eenmalig verbinden zonder opslaan via het profielvenster aanwezig. Groep is een zichtbaar tekstveld zonder groepsnavigatie; aparte testactie en directe host/gebruiker/poort-invoer in de quickconnectbalk ontbreken. | `ProfileDialog.tsx`, `App.tsx` |
| P0 — bookmarks, meerdere servers met eigen paden | Bron aanwezig: padparen en in-memory padstaat per verbinding+endpoint. Wissels verbergen verouderde rijen. Herstel van alle verbindingspaden na herstart niet aangetoond. | `App.tsx:connectionViews`, `remoteContext` |
| P0 — bestanden/volledige mappen overdragen, standaard vier sessies, navigatie en totaalgrens één | Bron aanwezig; sessieleases en queue hebben offline controles. Geen echte transport-/doorvoermeting. | `remote.ts`, `queue.ts`, `queue.test.ts` |
| P0 — duurzame queue, voortgang/snelheid/ETA/prioriteit, pause/resume/cancel/retry/clear | Bron aanwezig. Herstart pauzeert werk; hervatten begint opnieuw. Maximaal vier automatische pogingen totaal, dus drie retries; handmatige retry start een nieuwe reeks. Onopgeloste hersteltransacties blijven bewaard bij clear. | `queue.ts`, `QueuePanel.tsx` |
| P0 — gekoppelde navigatie beide kanten, rootgrenzen, ontbrekende map niet aanmaken | Mapping en begrenzing aanwezig; een ontbrekende tegenmap geeft een lijstfout en wordt niet automatisch gemaakt. End-to-endbediening nog onbewezen. | `App.tsx:navigate`, `core/browserWorkspace.ts` |
| P0 — conservatieve metadata-vergelijking | Bron aanwezig; ontbrekende betrouwbare metadata geeft onzeker/conflict. Grootte+tijd zijn geen inhoudsbewijs en sluiten gelijktijdige serverwijzigingen niet volledig uit. | `core/browserWorkspace.ts`, `queue.ts` |
| P0 — afzonderlijke display/transfer/sync-filters, naam/extensie/pad/map/grootte/datum, glob/regex, profielen | Deels: afzonderlijke projectregels en alle velden aanwezig; regex is een begrensde subset. Herbruikbare benoemde filterprofielen ontbreken. Standaard ontwikkelmapuitsluitingen en gevoelige-padcontrole aanwezig. | `ProjectDialog.tsx`, `core/browserWorkspace.ts`, `service.ts` |
| P0 — Monaco HTML/PHP/CSS/JS/JSON/XML/SQL/MD/TXT, completion/folding/format/find/undo | Taalregistratie, Monaco-basisfuncties en HTML/CSS/JSON/TS-workers aanwezig. Geen bewijs dat formattering/completion voor elke gevraagde taal beschikbaar is; PHP/XML/SQL hebben geen eigen taalserver/formatterimplementatie. | `CodeEditor.tsx`, `scripts/build.mjs` |
| P0 — BOM/EOL, dirty, recovery, tabs | Bron aanwezig: BOM-behoud, modellen/undo/view per document, herstelopslag. Crashgedrag en herstel van allerlaatste toetsen nog niet op desktop bewezen. | `CodeEditor.tsx`, `App.tsx`, `service.ts` |
| P0 — remote cache-edit, originele metadata, conflictdiff, Save As/upload/auto-upload standaard uit | Deels: endpointgebonden cache, snapshots, Save As en bewaakte upload aanwezig. Een remote conflictdiff met ophalen/vergelijken van beide versies ontbreekt; foutmelding alleen is geen diff. | `App.tsx`, `service.ts`, `shared/contracts.ts` |
| P0 — credentials/TLS/SSH/padbeveiliging/geïsoleerde bridge | Beveiligingsgrenzen geïmplementeerd; offline deelcontroles geslaagd. Werkelijke TLS/SSH/Electron/DPAPI-tests nog open. | `remote.ts`, `storage.ts`, `main.ts`, `preload.ts`, `security.test.ts` |
| P0 — project-CRUD, recent, tabs herstellen, instellingen | Deels: CRUD, laatste actieve project, lokale open bestanden en instellingen aanwezig. Expliciete recent-projecthistorie/-volgorde ontbreekt. | `App.tsx`, `ProjectDialog.tsx`, `service.ts` |
| P1 — exacte statische HTML/source-selectie beide kanten | Bron aanwezig met bronoffsets/revisiecontrole; DOM-drag is gebonden aan document en bronhash. Parser- en Electron-tests niet uitgevoerd. | `core/source.ts`, `EditorPane.tsx` |
| P1 — CSS-navigatie inline/intern/extern; selectors/classes/cascade/specificiteit/overerving/media/herkomst | Deels: inline bewerking en handmatig externe CSS-regels openen/bewerken. Gematchte stijlen voor geselecteerd element, cascade, specificiteit, overerving, media-context en property provenance ontbreken. | `EditorPane.tsx`, `core/source.ts` |
| P1 — externe CSS visueel wijzigen met gedeelde-selectorimpact en frameworkbehoud | Deels: gerichte externe CSS-bronpatches; geen impactberekening of waarschuwing over andere elementen met dezelfde selector. Frameworkcompatibiliteit niet bewezen. | `EditorPane.tsx`, `core/source.ts` |
| P1 — PHP/templates/scripts behouden; onveilige visuele edits weigeren | Blokkerende bronanalyse en beperkte patches aanwezig; volledige parserregressies nog niet uitgevoerd. Optionele afzonderlijke pagebuilder niet geïmplementeerd. | `core/source.ts`, `source.test.ts` |
| P1 — WYSIWYG tekst/headings/link/img/table/form/button/container/columns/nav/Flex/Grid | Deels: statische blokken invoegen en attributen/tekst bewerken aanwezig. Geen complete canvasgestuurde layout-/resize-/drag-and-dropbewerking van al deze elementen. | `BlockPalette.tsx`, `EditorPane.tsx` |
| P1 — DOM tree/select/attrs/duplicate/remove/move/drag | Bron aanwezig voor veilige statische nodes; dynamische bron wordt geweigerd. | `EditorPane.tsx`, `core/source.ts` |
| P1 — code/visual/split/preview, responsive, relatieve assets, JS, default/Edge/Chrome | Deels: vier modi/breedtes/assetinlining en standaardbrowser aanwezig. Ingebouwde preview schakelt projectscripts expliciet uit. Edge/Chrome-keuze zit in backend maar heeft geen keuzebediening. Externe statische preview kan JS uitvoeren. | `EditorPane.tsx`, `renderer/preview.ts`, `main/preview.ts`, `service.ts` |
| P1 — optionele zelf ingestelde PHP-server, nooit automatisch starten | Loopback-URL-configuratie aanwezig; app start/installeert geen PHP. Dynamische bron blijft uit interne preview. | `ProjectDialog.tsx`, `main/preview.ts` |
| P1 — gerelateerde HTML/CSS/JS/images/imports/urls/statische PHP includes en dependency-publicatiepreview | Deels: beperkte statische dependencydetectie en publicatieoptie aanwezig; PHP-delimiters leiden tot geen dependencydetectie, dus statische PHP-includes ontbreken. | `core/source.ts:discoverDependencies`, `core/publishing.ts`, `PublishDialog.tsx` |
| P1 — project search/replace, regex, vooraf diff/selectie | Bron aanwezig met preview en bronhashcontrole; regex is een veilige subset, geen volledige JavaScript-regex. | `SearchDialog.tsx`, `core/workspace.ts` |
| P1 — snippets CRUD/search/groepen | Deels: CRUD aanwezig; zoekveld en groepsindeling ontbreken. | `SnippetsDialog.tsx` |
| P1 — manifest/hashes dev/staging/prod, productiebevestiging, conflictplan, upload/download/beide, geen autodelete | Bron aanwezig met configureerbare omgevingen, endpointgebonden manifest en geverifieerde completions. Geen globale atomaire deploymentgarantie. | `core/publishing.ts`, `PublishDialog.tsx`, `service.ts` |
| P1 — recursive remote metadata search/cancel/result open/download/edit/rename/navigate | Nieuwe implementatie en servicebediening aanwezig. Filters op naam/pad/type/grootte/datum; geen inhoudsdownload bij zoeken. Downloads uit resultaten weigeren bestaande doelbestanden, ook recursief. Volledige tests nog open. | `main/remoteSearch.ts`, `SearchDialog.tsx`, `service.ts` |
| P1 — alleen bewezen veilige offset-resume, anders restart | Veilige restart-keuze aanwezig; geen byte-offset-resume geïmplementeerd of geclaimd. | `queue.ts`, `remote.ts` |
| P1 — chmod numeriek+checkboxes, recursief met bevestiging | Deels: octale invoer en backendrecursie aanwezig. Checkboxeditor en recursieve UI-keuze/bevestiging ontbreken. | `App.tsx:fileAction`, `service.ts:mutateRemote` |
| P1 — gedetailleerde logs, niveau-filter, zoekveld, geen secrets | Deels: niveaus, tekstfilter, verbindingsfilter en redacties aanwezig. Apart niveaufilter ontbreekt. | `QueuePanel.tsx`, `service.ts:log`, `remote.ts` |
| Oplevering — portable Windows EXE/ZIP, bron/build/instructies, echte 1/2/4/8- en duizendenbestandmetingen | Bron, scripts en instructies aanwezig. Geen gebouwd/gevalideerd Windows-artifact. Benchmarkharnas geschreven, niet uitgevoerd; geen representatieve performanceclaim. | `package.json`, `scripts/benchmark-transfers.mts`, `TESTRESULTS.md` |

Componentnamen zonder pad staan onder `src/renderer/components`; `service.ts`, `queue.ts`, `remote.ts` staan onder `src/main`.

## Integriteitsgrenzen

Lokale vervanging vereist hardlinks op hetzelfde bestandssysteem. Een mislukte hardlinkproef weigert de wijziging voordat het origineel wordt verplaatst. FAT/exFAT/netwerkshares zijn hiermee niet algemeen ondersteund of gevalideerd. De code bewaart POSIX-modebits en een oorspronkelijke reservekopie; behoud van Windows-ACL's, eigenaar, alternate data streams of andere uitgebreide metadata wordt niet gegarandeerd.

FTP/SFTP bieden in deze adapters geen generieke conditionele rename met server-side compare-and-swap. Snapshotcontroles, staging en backups verkleinen de kans op onopgemerkte wijziging, maar een externe schrijver met dezelfde grootte/tijdstempel of een wijziging tussen laatste controle en rename blijft een protocolgrens. Lokale hashes zijn geen bewijs van gelijke serverinhoud zonder geverifieerde remote hash. Deze grenzen moeten bij acceptatie worden beoordeeld.
