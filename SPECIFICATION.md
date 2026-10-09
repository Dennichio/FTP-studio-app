# FTP Studio — functionele specificatie

**Status:** beschrijving van de huidige broncode, versie 1.0.0. Dit document is geen bewijs van een afgerond of gevalideerd Windows-product. Windows-build, installer/ZIP-artifact, typecheck en Vitest-resultaten zijn nog niet beschikbaar; dependency-installatie werd geblokkeerd door ontbrekende shell-netwerktoegang.

## Doel en doelgroep

FTP Studio is een desktopwerkplek voor webontwikkelaars die lokaal bestanden bewerken, verbinding maken met een webserver en overdrachten vooraf willen controleren. De combinatie is bedoeld om veel dagelijkse taken van een code-editor en FTP/SFTP-client in één venster uit te voeren. De huidige app is een bruikbare basis, geen volledige Dreamweaver- of FileZilla-vervanger.

De primaire interface en meldingen zijn Nederlandstalig. De applicatie is gebouwd met Electron 41, TypeScript, React en Monaco Editor. De projectmetadata noemt Windows x64 ZIP als distributiedoel. Een Windows-build is nog niet aangetoond.

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
