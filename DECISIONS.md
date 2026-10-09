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
