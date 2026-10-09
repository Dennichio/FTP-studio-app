# Werkelijk uitgevoerde controles

Datum: 9 oktober 2026. Omgeving: Linux x64, Node.js 24.19.0, npm 11.9.0. Windows en Electron zijn niet gestart.

| Controle | Resultaat | Bewijs / grens |
|---|---|---|
| `node --no-warnings scripts/offline-check.mjs` | 5/5 geslaagd | Echte bronmodules, tijdelijk bestandssysteem, SQLite en Node test runner. |
| `node --no-warnings scripts/verify-queue-offline.mjs` | 31/31 geslaagd | Ongewijzigde testbodies uit queue.test.ts met expliciet meegeleverde Node-assertadapter in plaats van Vitest. Echte lokale I/O; gecontroleerde remote testdubbel. |
| Vier geïsoleerde RemoteManager-controles | Geslaagd | Uitgevoerde bronextractie in tijdelijk Node-script: reservering navigatiesessie, limiet één, geannuleerde handshakes, disconnect tijdens handshake. Geen echte FTP/SSH-transporttest. |
| Syntaxtransformatie van 26 TypeScript-bestanden | Geslaagd op laatste controlemoment | Node stripTypeScriptTypes; geen semantische typecontrole, geen TSX-validatie. De volledige build blijft noodzakelijk. |
| Afzonderlijke workspace-racecontroles door subagent | Geslaagd | Gelijktijdige opslag, opnieuw aangemaakte bestemming, geen hardlinkondersteuning, behoud rechten, FIFO-weigering. Geen Windows-uitvoering. |
| `npm ls --depth=0 --offline` | Mislukt, ELSPROBLEMS | Dependencies ontbreken; geen node_modules of eerste package-lock aanwezig. |
| Volledige `npm test` / Vitest | Niet uitgevoerd | Vitest en parser/protocoldependencies ontbreken. |
| `npm run typecheck` | Niet uitgevoerd | TypeScript/types ontbreken. |
| `npm run build`, desktoptests en Windows ZIP | Niet uitgevoerd | Bouwtools/Electron ontbreken. Er is geen geverifieerde EXE. |
| FTP, FTPS, SFTP lokale integratietests | Geschreven, niet uitgevoerd | Tests met lokale servers en echte transportlibraries staan klaar. Libraries ontbreken en sandbox weigert lokale sockets zonder netwerktoestemming. |
| Windows DPAPI, GUI/DPI, NTFS-crashherstel | Niet uitgevoerd | Vereist Windows-testmachine. |

## Offline dekking

De vijf kerncontroles testen Windows-/UNC-/POSIX-padkoppeling en mapgrenzen; conservatieve metadatavergelijking en filters; SQLite-heropening en weigering van onveilige credentialopslag; UTF-8 BOM/CRLF, verouderde saves/vervangingsplannen en symlinks; gepauzeerd wachtrijherstel zonder netwerksessie.

De 31 wachtrijgevallen omvatten serveridentiteit vóór en tijdens sessieopening, profielwijziging na herstel, maprecursie, standaard- en projectfilters, gevoelige bestanden, gekoppelde hoofdmappen, begrensde paralleliteit, prioriteit, dubbele doelen, tijdelijke bestanden, terugzetten van originelen, tussentijdse lokale/serverwijzigingen, onvolledige overdrachten, snapshotbewaking, pauze/annulering, commitbescherming, maximaal vier retries, herstel na afsluiten en behoud van onopgeloste herstelgegevens.

De remote testdubbel simuleert fouten en metadata expliciet; deze bewijst geen servercompatibiliteit, werkelijke netwerksnelheid of FTP/SSH-beveiliging. De vaulttest bewijst weigering van onveilige opslag, niet de werking van Windows DPAPI.

## Voorbereide volledige tests

`tests/source.test.ts`, `workspace.test.ts`, `publishing.test.ts`, `remote.test.ts`, `queue.test.ts`, `main.test.ts` en `security.test.ts` bevatten gerichte unit-/integratiegevallen. `tests/e2e/desktop.spec.ts` start de echte Electron-app en gebruikt geïsoleerde projectbestanden. Deze suites zijn pas geslaagd als hun echte runners succesvol zijn uitgevoerd.

## Meetresultaten

Er zijn nog geen representatieve metingen van FTP/SFTP-doorvoer, duizendbestandoverdrachten, geheugengebruik of Windows-opstarttijd. De standaard vier transfers is een configureerbare ontwerpkeuze, geen op deze omgeving bewezen optimum.
