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
| Windows-artifact | Electron Builder x64 ZIP target | Geen installer/signing claim. Eerdere cross-compiled ZIP is verouderd; definitieve build moet opnieuw worden verpakt en is geen Windows-runtimevalidatie. |

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
| Meetbaarheid | Loopbackharnas voor 1/2/4/8 transfers en kleine/grote bestanden; twee matrices van 16 scenario’s zijn uitgevoerd | Elke matrix controleerde 8.128 bestanden op SHA-256. Resultaten betreffen de gezamenlijke MLST/SQLite/UI-coalescing wijziging op Linux; details en beperkingen staan in `docs/BENCHMARKS.md`. |

Deze technische keuzes documenteren de huidige implementatie. Zij geven geen toestemming om ontbrekende expliciete P0/P1-eisen als afgerond te markeren. [SPECIFICATION.md](SPECIFICATION.md) houdt het resterende functionele werk bij; [TESTRESULTS.md](TESTRESULTS.md) scheidt uitgevoerde controles van voorbereide tests.

## Historische dependency- en integratiecontrole

- Behoud de bestaande Base Environment: een expliciet goedgekeurde `require_escalated`-uitvoering bereikte npm via de beheerde proxy en downloadde ook Electron. De standaard-sandbox blijft beperkt; eerdere aanvragen met uitsluitend extra netwerkrechten bleven zonder bruikbaar resultaat.
- Leg de opgeloste versies vast in package-lock.json. Een smalle lokale SFTP-v12-declaratie beschrijft de werkelijk gebruikte runtime-API omdat de beschikbare v9-types lstat en stream-offsetopties missen. Ze gebruikt getypeerde ssh2-streamopties en is onafhankelijk gereviewd; protocolcontroles zijn niet omzeild.
- Gebruik de door PostCSS geleverde exclusieve eindoffset rechtstreeks. De echte regressietests toonden dat een extra +1 omliggende bronbytes kon beschadigen. Weiger bovendien visuele patches wanneer parserherstel bronranges verplaatst of expliciete sluit-tags ontbreken.

## 10 oktober 2026 — afhankelijkheden en vergelijkingsfunctie

Na de npm-audit is basic-ftp bijgewerkt naar 6.2.3. Afwijkende PASV-datahosts worden standaard geweigerd; de adapter blijft die veilige instelling gebruiken. Protocoltests gebruiken echte loopbackservers.

DOMPurify 3.4.16 is expliciet vastgelegd. Monaco 0.55.1 bevat daarnaast een eigen oudere kopie: een nauw begrensde esbuild-resolutie vervangt daarom de import vanuit Monaco's domSanitize.js door het bijgewerkte pakket. Metafilecontroles weigeren de oude bron in de renderer en iedere sanitizer in editorworkers. Een audit zonder meldingen alleen bewijst deze bundeleigenschap niet.

De bestandsvergelijking toont twee alleen-lezen momentopnamen. Zij verandert geen hersteltekst, werkcache of uploadbasis. Serverinhoud wordt apart, begrensd en endpointgebonden gelezen. Broncodewijzigingen blijven een bewuste actie in de gewone editor. Nieuwere hersteltekst tijdens opslaan wordt na de schijfcommit behouden en op de nieuwe metadata gebaseerd.

## Wachtrijvirtualisatie met natuurlijke rijhoogtes — 10 oktober 2026

Gekozen voor een lokale gevirtualiseerde lijst zonder nieuwe dependency. Vaste afgekorte rijen zouden volledige foutmeldingen verbergen; daarom worden natuurlijke rijhoogtes gemeten en in een cache bewaard. De volledige filterverzameling blijft de bron voor pauzeren/hervatten/wissen, onafhankelijk van de zichtbare DOM. Onafhankelijke A-review leidde tot herstel van achterblijvende focusverzoeken en scrollankering na hoogtekrimp. Echte Electron-tests met 2.000 SQLite-overdrachten en 2.000 werkelijke filesystemfouten slagen, inclusief filteracties, lange tekst, resize, focus en log-prepends. Dit verandert de overdrachtsengine niet.

## 1.0.1 — gekozen lokale map, vroege start en verwijderbare conflicten

De gebruiker wil expliciet buiten de lokale profielmap kunnen overdragen. Daarom krijgt een handmatige opdracht een eigen, duurzaam opgeslagen lokale root, in plaats van globale padvalidatie uit te schakelen of het verbindingsprofiel stil te wijzigen.

De gebruiker meldde dat 1.400 foto's eerst langdurig metadata uitlezen zonder zichtbare overdracht. Een directe voorbereidingsstatus en batches van 16 geselecteerde items maken de start zichtbaar en laten eerdere batches al uitvoeren. Dubbele metadata-opvraging vanuit de renderer is vervangen door conservatieve verwachtingen uit de actuele listing; de engine behoudt de uiteindelijke conflictcontrole.

De oude clear-regel weigerde conflicten met hersteltransacties en de rij-annuleerknop deed niets bij terminale conflicten. De rij krijgt nu een echte verwijderactie. Conflicten met herstelgegevens worden duurzaam gearchiveerd, zodat ze uit de wachtrij verdwijnen zonder dat gegevens worden weggegooid.
