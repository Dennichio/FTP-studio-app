# FTP Studio

FTP Studio brengt lokale projectbestanden, een code-editor, FTP/FTPS/SFTP en gecontroleerde bestandsoverdracht samen in één desktopapp. De huidige versie bevat een Nederlandstalige React/Electron-interface, Monaco-editor, projectbeheer, lokale en serverbestandspanelen, zoek/vervang, een transferqueue en publicatieplannen.

De applicatie biedt een beperkte bronbewuste HTML/CSS-inspector. Ze is geen volledige drag-and-drop page builder, voert geen PHP uit en installeert geen PHP-afhankelijkheden. PHP/templates blijven in de code-editor intact; preview vereist voor dynamische pagina's een door de gebruiker ingestelde lokale server. Een publicatieplan is handmatig te controleren overdracht, geen continue sync.

## Status

De huidige build is op Linux gecompileerd en gecontroleerd: **408/408 Vitest-tests in 19 suites (63,29 s)**. De uitgebreide Electron/Xvfb-ronde haalde **38/40**; na herstel van de labels in het vergelijkingsvenster slaagden **alle vijf betreffende scenario’s (20,1 s)**. De overige 35 scenario’s waren geslaagd. Dit is geen nieuwe volledige 40/40-run. Typecheck en applicatiebuild zijn groen. De actuele Windows x64 ZIP is samengesteld en op inhoud, CRC en SHA-256 gecontroleerd; Windows-uitvoering, DPI en DPAPI blijven ongeverifieerd. De volledige masterprompt is nog niet afgerond.

De distributie staat onder `release/FTP-Studio-1.0.0-win-x64.zip`. Pak de hele ZIP uit en start `FTP Studio.exe`; zie [Windows-installatie](docs/INSTALLATIE-WINDOWS.md). Broncode en overdrachtsarchief staan onder `artifacts/`. Beide loopback-benchmarkmatrices zijn afgerond: elk 16 scenario’s en 8.128 gecontroleerde bestanden. Zie [benchmarkrapport](docs/BENCHMARKS.md), [testresultaten](TESTRESULTS.md) en [resterende eisen](SPECIFICATION.md).

## Ontwikkelen

Vereist: Node.js-versie passend bij Electron 41 en npm, plus netwerktoegang tot de geregistreerde dependencies.

```sh
npm ci
npm run build
npm run dev
```

Beschikbare controles en distributiescripts:

```sh
npm run typecheck
npm test
npm run dist:win
```

`dist:win` maakt een zelfstandige Windows x64 ZIP met Electron en lokale editorassets. De executable is niet digitaal ondertekend. `npm run dist:linux` is eveneens beschikbaar; een cross-build bewijst geen Windows-runtimegedrag.

## Eerste gebruik

1. Maak een verbinding met host, poort, gebruikersnaam, lokale root en remote root.
2. Kies FTP, FTPS of SFTP. Bij SFTP haalt u de SHA-256-hostvingerafdruk op via een vertrouwde providerbron en controleert u die vóór opslaan en verbinden.
3. Sla een wachtwoord of sleutelwachtzin alleen op als Electron safeStorage op het systeem beschikbaar is. Credentials worden versleuteld en gekoppeld aan de verbindingsidentiteit; legacycredentials moeten opnieuw worden ingevoerd en opgeslagen.
4. Maak een project met de lokale hoofdmap en serverhoofdmap. Koppel desgewenst een profiel, stel omgevingen/filters in en geef alleen voor een lokaal draaiende previewserver een `localhost`-URL op.
5. Open dubbelklikbestanden in de editor. Opslaan werkt lokaal; uploaden loopt via de queue en controleert wijzigingen op de server.
6. Gebruik **Publiceren** om een plan te vergelijken, conflicten te bekijken en alleen de gewenste items in de queue te zetten. Voor productie vraagt de app een expliciete bevestiging.

Zie de [gebruikershandleiding](docs/USER-GUIDE.md) voor de volledige werkwijze en veiligheidsgrenzen.

## Licentie

De eigen broncode valt onder [MIT](LICENSE). Gebundelde dependencies behouden hun eigen licenties.

De gegenereerde `package-lock.json` legt de geïnstalleerde versies vast; gebruik `npm ci` voor volgende installaties. Offline kerncontroles werken zonder npm-downloads met Node.js 24: `npm run test:offline`, `npm run test:queue:offline`, `npm run test:search:offline` `npm run test:connections:offline` en `npm run test:permissions:offline`. Deze vervangen de volledige tests en Windows-validatie niet.
