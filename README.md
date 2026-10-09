# FTP Studio

FTP Studio brengt lokale projectbestanden, een code-editor, FTP/FTPS/SFTP en gecontroleerde bestandsoverdracht samen in één desktopapp. De huidige versie bevat een Nederlandstalige React/Electron-interface, Monaco-editor, projectbeheer, lokale en serverbestandspanelen, zoek/vervang, een transferqueue en publicatieplannen.

De applicatie biedt een beperkte bronbewuste HTML/CSS-inspector. Ze is geen volledige drag-and-drop page builder, voert geen PHP uit en installeert geen PHP-afhankelijkheden. PHP/templates blijven in de code-editor intact; preview vereist voor dynamische pagina's een door de gebruiker ingestelde lokale server. Een publicatieplan is handmatig te controleren overdracht, geen continue sync.

## Status

De repository en buildconfiguratie zijn aanwezig, maar dependency-installatie werd geblokkeerd door shell-netwerktoegang. Typecheck, formele tests, Windows x64 artifact en Windows runtime zijn daarom nog niet vastgesteld. Bekijk [voortgang](PROGRESS.md), [specificatie](SPECIFICATION.md) en [releasechecklist](docs/RELEASE-CHECKLIST.md) voordat u productiegebruik overweegt.

## Ontwikkelen

Vereist: Node.js-versie passend bij Electron 41 en npm, plus netwerktoegang tot de geregistreerde dependencies.

```sh
npm install
npm run build
npm run dev
```

Beschikbare controles en distributiescripts:

```sh
npm run typecheck
npm test
npm run dist:win
```

`dist:win` is geconfigureerd voor een x64 ZIP-artifact via Electron Builder. Het script en de targetconfiguratie garanderen geen werkende Windows-build; voer de releasechecklist uit op Windows. `npm run dist:linux` is eveneens geconfigureerd, zonder platformvalidatieclaim.

## Eerste gebruik

1. Maak een verbinding met host, poort, gebruikersnaam, lokale root en remote root.
2. Kies FTP, FTPS of SFTP. Bij SFTP haalt u de SHA-256-hostvingerafdruk op via een vertrouwde providerbron en controleert u die vóór opslaan en verbinden.
3. Sla een wachtwoord of sleutelwachtzin alleen op als Electron safeStorage op het systeem beschikbaar is. Credentials worden niet als leesbare SQLite-waarden bewaard.
4. Maak een project met de lokale hoofdmap en serverhoofdmap. Koppel desgewenst een profiel, stel omgevingen/filters in en geef alleen voor een lokaal draaiende previewserver een `localhost`-URL op.
5. Open dubbelklikbestanden in de editor. Opslaan werkt lokaal; uploaden loopt via de queue en controleert wijzigingen op de server.
6. Gebruik **Publiceren** om een plan te vergelijken, conflicten te bekijken en alleen de gewenste items in de queue te zetten. Voor productie vraagt de app een expliciete bevestiging.

Zie de [gebruikershandleiding](docs/USER-GUIDE.md) voor de volledige werkwijze en veiligheidsgrenzen.

## Licentie

De eigen broncode valt onder [MIT](LICENSE). Gebundelde dependencies behouden hun eigen licenties.

Zodra `package-lock.json` is gegenereerd en gecontroleerd, gebruikt u `npm ci` voor reproduceerbare volgende installaties. Offline kerncontroles werken zonder npm-downloads met Node.js 24: `npm run test:offline` en `npm run test:queue:offline`. Deze vervangen de volledige tests en Windows-validatie niet.
