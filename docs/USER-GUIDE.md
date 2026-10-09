# Gebruikershandleiding

## Wat u kunt verwachten

FTP Studio combineert een lokale projectbrowser, remote browser, Monaco-code-editor, overdrachtsqueue en publicatieplan. De interface vervangt nog geen complete visuele websitebouwer: visuele bewerking is beperkt tot veilige, statische HTML-elementen en CSS-declaraties. Gebruik de code-editor voor templates en alle geavanceerde bronbewerking.

De app voert geen PHP uit. Voor bestanden met de extensie `.php`, `.phpN` of `.phtml` configureert u een eigen lokaal draaiende ontwikkelserver en diens loopback-URL in Projectinstellingen. De externe browserpreview gebruikt die URL; het interne visuele canvas blijft voor PHP en dynamische templates beschermd met een melding. Overige templates worden niet automatisch via de ingestelde server uitgevoerd. De oorspronkelijke bron blijft beschikbaar in de code-editor.

## Een verbinding instellen

Open Verbindingsbeheer en voeg een profiel toe. Vul een herkenbare naam, host, gebruikersnaam, lokale hoofdmap en remote hoofdmap in. Controleer de poort en eventuele time-out en sessielimieten.

Kies protocol bewust:

- **SFTP:** voer een SHA-256-hostfingerprint in. Haal die op via een onafhankelijke, vertrouwde bron van uw hostingprovider of beheerder en vergelijk exact vóór verbinding. Neem een fingerprint die alleen tijdens een onverwachte verbinding wordt getoond niet blind over. Bij een mismatch stopt de verbinding.
- **FTPS:** kies expliciete of impliciete TLS volgens uw provider. Ongeldige TLS-certificaten horen niet te worden genegeerd.
- **FTP:** verstuurt verbinding/gegevens zonder transportversleuteling. Gebruik dit alleen op een vertrouwd netwerk; geef de voorkeur aan SFTP of FTPS als uw server dit ondersteunt.

Voeg indien gewenst een privésleutel toe. De sleutel blijft op het lokale bestandssysteem; geef alleen het pad op. Wachtwoorden en sleutelwachtzinnen worden via Electron safeStorage opgeslagen wanneer dat beschikbaar is. Als veilige opslag niet beschikbaar is, slaat de app credentials niet persistent op.

## Project aanmaken

Een project bevat de lokale hoofdmap, serverhoofdmap en optioneel een standaardverbinding. De roots bepalen waar navigatie en bestandsoverdracht mogen werken. U kunt meerdere publicatieomgevingen maken en ze markeren als productie. Een lokale preview-URL moet naar een server op loopback verwijzen.

Filters hebben aparte scopes voor weergave, overdracht en synchronisatie. Gebruik filters om bijvoorbeeld gegenereerde of vendor-mappen te verbergen/uitsluiten. Veiligheidsuitsluitingen voor gevoelige bestandstypen en veelvoorkomende ontwikkelmappen blijven gelden.

## Bestanden bekijken en bewerken

De linker- en rechterpanelen tonen lokale en externe bestanden. Dubbelklik een bestand om het in de editor te openen. Verborgen bestanden zijn via Instellingen zichtbaar te maken. Gekoppelde navigatie volgt relatieve paden binnen de projectroots.

De editor bewaart herstelgegevens voor niet-opgeslagen wijzigingen. Gebruik Ctrl+S om lokaal op te slaan. Schakel automatisch uploaden alleen in wanneer u bewust elk lokaal opslaan naar de actieve serververbinding wilt laten doorzetten. Een mislukte upload laat de lokale save bestaan en meldt de fout.

Visueel bewerken kan alleen als HTML/CSS parseerbaar en statisch genoeg is. De visuele inspector past bronpatches toe en kan tekst, attributen, beperkte elementen en CSS-declaraties wijzigen. Scripts, stylesheets als documentblokken, templates, dynamische attributen en parserambiguïteit zijn beschermd. Als de inspector blokkeert, bewerk de bron in Monaco.

Zoek/vervang in het project biedt vooraf een lijst met wijzigingen. Controleer het voorbeeld; toepassen controleert of de bron sinds het voorbeeld niet is gewijzigd en bewaart backups. Werk alleen binnen projecten waarvan u eigenaar bent.

## Overdragen

Selecteer lokale items om te uploaden of externe items om te downloaden. De queue toont status en voortgang en biedt pauzeren, hervatten, annuleren, prioriteit en opnieuw proberen. Mapoverdracht wordt uitgebreid naar bestanden, met begrenzingen en uitsluitingen.

Bij een conflict is een bron of doel sinds planning gewijzigd of niet veilig vergelijkbaar. De app stopt die job. Bekijk lokaal en extern, kies bewust welke versie leidend is en plan daarna opnieuw. Hervatten start de transfer vanaf het begin; FTP Studio ondersteunt geen veilige byte-offset-resume.

De queue gebruikt staging en snapshots voor rollback waar mogelijk. De garantie hangt af van protocol en servergedrag. Controleer belangrijke deploys na overdracht ook via uw normale server-/sitecontrole.

Gevoelige namen zoals `.env`, `.ssh`, credentialbestanden en private keys zijn standaard uitgesloten. Forceer hun overdracht niet zonder expliciete noodzaak en controleer de bestemming zorgvuldig. `.git`, `node_modules`, cache- en backupmappen zijn eveneens standaard uitgesloten van bulkoverdracht.

## Publicatieplan

Kies **Publiceren** en selecteer de omgeving, richting en eventueel een subset. De app vergelijkt lokale en serverbestanden en toont uploads, downloads, conflicten en overgeslagen items. Schakel statische gerelateerde CSS/scripts/afbeeldingen alleen in als die afhankelijkheden gewenst zijn.

Controleer elk item en vink alleen veilige wijzigingen aan. Conflicten worden niet automatisch geselecteerd; los ze op door versies te vergelijken en een nieuw plan te maken. Voor een als productie gemarkeerde omgeving moet u `PUBLICEREN` typen. De gekozen overdracht gaat daarna naar de queue. Publicatie verwijdert niet automatisch remote bestanden en is geen permanente synchronisatie.

## Log en instellingen

Instellingen bieden thema, editorfont, word wrap, zichtbaarheid van verborgen bestanden, gekoppelde navigatie en automatisch uploaden. De logweergave helpt bij het zien van queue-/verbindingsgebeurtenissen. Deel logbestanden pas nadat u hebt gecontroleerd dat er geen gevoelige serverinformatie in staat.

Projecten, instellingen, snippets, queue- en herstelgegevens staan lokaal in SQLite onder Electron `userData`. Verwijderen of verplaatsen van dit profiel kan lokale staat beïnvloeden; maak een backup als die gegevens belangrijk zijn. Credentialversleuteling is aan de lokale OS-gebruiker gebonden.

## Bekende grenzen

De app is nog niet formeel gevalideerd op Windows. Beschikbaarheid van protocolspecifieke functies verschilt per server. Er is geen PHP-runtime, debugger, dependency manager, volledige page builder, remote delete-sync of hervatten vanaf transfer-offset. Test belangrijke wijzigingen eerst op een niet-productieomgeving.
