# FTP Studio op Windows

Doelplatform: Windows 11 x64. Deze distributie bevat Electron, de applicatie en alle editorassets; Node.js, .NET en een aparte browserruntime hoeven niet te worden geïnstalleerd.

1. Download `FTP-Studio-1.0.1-win-x64.zip` en pak de **hele ZIP** uit in een eigen map, bijvoorbeeld `C:\Apps\FTP Studio`.
2. Start `FTP Studio.exe` uit die map. Laat de meegeleverde DLL's, `resources` en `locales` bij het programma staan.
3. Open **Project → Nieuw project** en kies uw lokale websitemap. Voeg via **Verbindingsbeheer** een FTP-, FTPS- of SFTP-profiel toe en stel de serverhoofdmap in.
4. Dubbelklik op een bestand om het te bewerken. Gebruik **Opslaan** voor lokale opslag en **Opslaan en uploaden** om een gecontroleerde overdracht in te plannen.

Voor SFTP is een vooraf gecontroleerde SSH-hostvingerafdruk vereist. U kunt wachtwoorden bewaren wanneer Windows veilige credentialopslag beschikbaar stelt. Automatisch uploaden staat standaard uit.

De ZIP is een zelfstandige mapdistributie, geen installer. Gebruikersgegevens worden apart onder het Windows-gebruikersprofiel opgeslagen, doorgaans `%APPDATA%\FTP Studio`. Sluit de app voordat u van die map een reservekopie maakt. Wachtwoordversleuteling is aan de Windows-gebruiker gebonden.

## Validatiestatus

De build is op Linux voor Windows x64 samengesteld. De applicatie is met Electron onder Linux getest; starten op Windows, Windows-DPI en DPAPI zijn nog niet op het doelplatform gecontroleerd. De executable is niet digitaal ondertekend. Dit is een ontwikkelbuild met bekende functionele grenzen, geen definitieve oplevering van de volledige masterprompt.

Lees [de gebruikershandleiding](USER-GUIDE.md), [testresultaten](../TESTRESULTS.md) en [de resterende eisen](REQUIREMENTS.md). Bij een opstartfout zijn de exacte Windows-versie en foutmelding nodig voor onderzoek.

## Bijwerken of verwijderen

Sluit FTP Studio en pak een nieuwe build uit in een nieuwe map. Bewaar de oude map tot de nieuwe build werkt. Verwijder de programmamap om de applicatie te verwijderen; dit verwijdert uw websites en afzonderlijke gebruikersgegevens niet.
