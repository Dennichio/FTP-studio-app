# Releasechecklist

Deze checklist is een openstaande releasepoort. De huidige repositorystatus is **niet vrijgegeven**: dependencies konden niet volledig worden geïnstalleerd door ontbrekende shell-netwerktoegang; typecheck, Vitest en Windows artifact/start zijn niet vastgesteld.

## Build en bewijs

- [ ] Voer `npm install` uit zolang de eerste lockfile ontbreekt; controleer en bewaar die lockfile. Gebruik daarna `npm ci`.
- [ ] Voer `npm run typecheck` uit; noteer Node/npm-versie en resultaat.
- [ ] Voer `npm test` uit; noteer aantal suites/tests en resultaat. Voeg geen fictieve uitkomsten toe.
- [ ] Bouw op Windows x64 met `npm run dist:win`.
- [ ] Noteer artifactnaam, hash, buildomgeving en Electron/Node-versie. Controleer ZIP-inhoud en start de app vanaf een schone installatie/profiel.
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

- [ ] Open, bewerk en sla UTF-8 LF- en CRLF-bestanden op; controleer encoding/eol en herstel na herstart.
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
- [ ] Controleer dat `LICENSE`-bestand overeenkomt met de gedeclareerde MIT-licentie.
- [ ] Review release notes en documentatie tegen de daadwerkelijk gebouwde versie.
- [ ] Markeer release als gereed pas nadat alle vereiste blokkers zijn afgehandeld of expliciet geaccepteerd.
