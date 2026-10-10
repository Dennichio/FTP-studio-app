# Technische beslissingen

| Onderwerp | Beslissing | Reden en grens |
|---|---|---|
| Desktopstack | Electron 41, TypeScript, React, Monaco | Past bij een zelfstandige Windows-werkplek en ingebedde code-editor. Windows-packaging moet nog worden aangetoond. |
| Procesgrens | UI in renderer; lokale/netwerktoegang in main/core via getypeerde preload-bridge | Houdt systeemtoegang uit de interfacecode en maakt IPC-contracten expliciet. |
| Remote protocollen | `basic-ftp`, `ssh2-sftp-client`; FTP, FTPS expliciet/impliciet, SFTP | Beperkte protocoldekking; geen claim voor WebDAV/cloud-opslag of alle servervarianten. FTP versleutelt geen transport. |
| SFTP trust | Vooraf vertrouwde SHA-256-hostvingerafdruk verplicht | Voorkomt stil vertrouwen in een onbekende of vervangen serverkey. Operator moet fingerprint buiten de verbinding controleren. |
| Credentials | Electron safeStorage; SQLite bewaart ciphertext | Voorkomt leesbare credentialvelden. Als systeemopslag niet beschikbaar is, persistent opslaan wordt geweigerd. Windowsgedrag vereist releasevalidatie. |
| Lokale staat | SQLite onder Electron userData | Duurzame instellingen, profielen, projecten, snippets, hersteldata en queue. De database bevat geen onversleutelde opgeslagen wachtwoorden. |
| Bronbewuste visuele editor | parse5/PostCSS source ranges en beperkte patches | Behoudt bronopmaak beter dan documentserialisatie. Bij dynamische/ongeldige structuur wordt visueel bewerken geblokkeerd. Geen volwaardige visuele page builder. |
| Dynamische preview | Alleen optionele localhost/loopback URL voor server-side rendering | De desktopapp voert PHP of templates niet uit en stuurt die bron niet als previewdocument naar de browser. Zonder lokale server wordt een placeholder getoond. |
| Transferstrategie | Persistent queue, max 32 actieve jobs globaal, standaard projectinstellingen begrenzen sessies; staging en rollback snapshots | Beperkt conflictrisico en voorkomt directe overschrijving waar staging werkt. Serverondersteuning en crashgedrag moeten operationeel worden gevalideerd. |
| Hervatten | Queue-hervatten start bestand opnieuw vanaf byte nul | Een protocol-lease kan geen generieke veilige offset-hervatting bewijzen. Geen resumability-claim. |
| Conflictbeleid | Vergelijk snapshots; onvergelijkbaar of gewijzigd doel resulteert in conflict | Grootte alleen geldt niet als voldoende bewijs van ongewijzigde remote inhoud. Operator beoordeelt beide versies en plant opnieuw. |
| Bulkfilters | Gevoelige namen en gangbare build/vendor-mappen standaard uitsluiten | Vermindert kans op publiceren van geheimen of ruis. Filters vervangen geen beoordeling; expliciete gevoelige bestandsoverdracht is apart gemarkeerd. |
| Publiceren | Eerst plan tonen, selectie door gebruiker, productiebevestiging | Maakt wijzigingen zichtbaar voordat de queue ze uitvoert. Conflicten en uitgesloten bestanden blijven buiten de overdracht. Geen continue sync of remote delete. |
| Windows-artifact | Electron Builder x64 ZIP target | Geen installer/signing claim. Nog niet gebouwd, geïnstalleerd of op Windows getest. |

## Aanvullende integriteitskeuzes en open acceptatiepunten

| Onderwerp | Beslissing | Reden en grens |
|---|---|---|
| Bestemmingsidentiteit | Canonieke endpointkey naast profiel-id in async verzoeken, queue, caches en manifesten | Profiel-id alleen is geen garantie dat host/gebruiker/root gelijk bleven. Controle vóór en na leaseacquisitie voorkomt herroutering tijdens wachten. |
| Remote baseline | Alleen metadata van de geverifieerde transfer overnemen, gebonden aan lokaal cachepad en endpoint | Een latere stat kan al een versie van een andere schrijver bevatten. Andere tabs/caches mogen die baseline niet erven. |
| Lokale installatie | Hardlinkproef, bewaarde oorspronkelijke backup en exclusieve hardlinkinstallatie | Voorkomt overschrijven van een intussen aangemaakte bestemming. Vereist hardlinks op hetzelfde bestandssysteem; geen algemene FAT/exFAT/shareclaim en geen gegarandeerd Windows-ACL/owner/ADS-behoud. |
| Remote races | Herhaalde snapshotcontrole, staging en backup; geen generieke CAS-claim | FTP/SFTP bieden in deze adapters geen server-side voorwaardelijke rename. Gelijke grootte/tijd is geen inhoudsbewijs; een laatste racevenster blijft bestaan. |
| Automatisch opnieuw proberen | Maximaal vier pogingen totaal, dus drie retries, met exponentiële vertraging | De eerste poging telt mee. Handmatige retry start opnieuw. Dit begrenst automatische herhaling, niet het totale aantal handmatig gestarte pogingen. |
| Ingebouwde preview | Projectscripts uit; alleen vertrouwde selectie-instrumentatie in opaque sandboxiframe | Isoleert onbetrouwbare preview van de desktopbridge. Daarmee is de geëiste interne JS-livepreview nog niet gerealiseerd; externe preview is een aparte functie. |
| Zoekregex | Begrensde subset om onbegrensde verwerking te voorkomen | Geen ondersteuning voor alle JavaScript-regexconstructies. UI en documentatie moeten deze beperking tonen. |
| Meetbaarheid | Apart loopbackharnas voor 1/2/4/8 transfers en veel kleine bestanden | Harnas is geen meetresultaat; RAM-server en JSON-geheugenstore meten geen volledige productieketen. |

Deze technische keuzes documenteren de huidige implementatie. Zij geven geen toestemming om ontbrekende expliciete P0/P1-eisen als afgerond te markeren. [SPECIFICATION.md](SPECIFICATION.md) houdt het resterende functionele werk bij; [TESTRESULTS.md](TESTRESULTS.md) scheidt uitgevoerde controles van voorbereide tests.
