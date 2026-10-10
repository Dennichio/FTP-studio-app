# Releasechecklist

Deze checklist onderscheidt de huidige ontwikkelbuild van een definitieve Windows-release. Typecheck/build en 408/408 Vitest-tests slagen. Desktop: 38/40, daarna 5/5 gerichte diffhercontrole. De actuele Windows x64 ZIP is een zelfstandige cross-build; Windows-start/DPAPI/DPI en volledige masterpromptacceptatie blijven open. Benchmarks zijn uitgevoerd; zie BENCHMARKS.md.

## Build en bewijs

- [x] Dependencies en lockfile zijn aanwezig; voer voor herhaalbare installatie `npm ci` uit.
- [x] Voer `npm run typecheck` uit; noteer Node/npm-versie en resultaat.
- [x] Voer `npm test` uit; noteer aantal suites/tests en resultaat. Voeg geen fictieve uitkomsten toe.
- [x] Windows x64 ZIP met `npm run build` en `electron-builder --win zip --x64` gemaakt; Linux-crossbuild is geen Windows-runtimevalidatie.
- [ ] Noteer artifactnaam, hash, buildomgeving en Electron/Node-versie. Controleer ZIP-inhoud en start de app vanaf een schone installatie/profiel. Actuele inhoudinspectie en hashes staan in WINDOWS-BUILD-CHECK.json; starten op Windows blijft open.
- [ ] Bevestig of code signing/installer nodig is. Huidige config maakt een ZIP en schakelt executable signing/editing uit.
- [ ] Voer de relevante gebruikersscenario's hieronder op de uiteindelijke Windows-build uit en leg afwijkingen vast.

## Verbindings- en geheimencontrole

- [ ] Test FTP alleen op een veilig testnetwerk; bevestig waarschuwing over onversleuteld transport.
- [ ] Test FTPS expliciet en impliciet tegen representatieve providers; ongeldige certificaten moeten falen.
- [ ] Test SFTP met vooraf via vertrouwde bron geverifieerde SHA-256 fingerprint.
- [ ] Bevestig dat verkeerde/onverwacht gewijzigde hostkey verbinding blokkeert.
- [ ] Bevestig credentialopslag met Windows safeStorage/DPAPI onder de ondersteunde Windowsversies; controleer dat credentialwaarden niet leesbaar in SQLite/log staan.
- [ ] Bevestig gedrag wanneer safeStorage niet beschikbaar is: credentials worden niet persistent opgeslagen.

## Bestand- en overdrachtsscenario's

- [ ] Open, bewerk en sla UTF-8 LF- en CRLF-bestanden op; behoud is onder Linux/Xvfb afzonderlijk gecontroleerd. Controleer ook encoding/EOL-herstel na Windows-herstart.
- [ ] Test padgrenzen, symlinks, Windows-gereserveerde namen, rootoverschrijding en remote `..`-paden.
- [ ] Test filters en gevoelige bestandsuitsluitingen voor gewone queue en publicatie.
- [ ] Test upload/download, mapuitbreiding, pauze/hervat (opnieuw vanaf nul), retry, cancel, prioriteit en queueherstel.
- [ ] Wijzig bron en doel na planning; bevestig dat de overdracht als conflict stopt.
- [ ] Simuleer staging-/commitfout en controleer rollback/snapshotgedrag voor iedere ondersteunde serverfamilie.
- [ ] Controleer na grote of productiegevoelige overdracht de uiteindelijke serverinhoud met een onafhankelijke methode.

## Editor, preview en publicatie

- [ ] Wijzig statische HTML tekst/attributen en CSS; controleer dat niet-aangepaste bronopmaak behouden blijft.
- [ ] Bevestig dat ongeldige/dynamische HTML, PHP, templates, scripts en beschermde elementen visueel niet worden aangepast.
- [ ] Bevestig dat PHP niet automatisch wordt uitgevoerd en dat alleen loopback-preview-URL's worden geopend.
- [ ] Test zoek/vervangvoorbeeld, stale-revision weigering en backup-herstel.
- [ ] Test publicatieplan in test- en als productie gemarkeerde omgeving; conflicten zijn niet vooraf geselecteerd, productie vraagt `PUBLICEREN`, remote bestanden worden niet automatisch verwijderd.
- [ ] Test op een lokale server met bekende statische assets en noteer niet-herkende afhankelijkheden.

## Afronding

- [ ] Werk `PROGRESS.md` en `TESTRESULTS.md` bij met echte uitkomsten, beperkingen en bekende problemen.
- [x] Eigen LICENSE is MIT; dependencylicenties blijven afzonderlijk van kracht.
- [ ] Review release notes en documentatie tegen de daadwerkelijk gebouwde versie.
- [ ] Markeer release als gereed pas nadat alle vereiste blokkers zijn afgehandeld of expliciet geaccepteerd.
