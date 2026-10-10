# Overdrachtsmetingen

## Nulmeting op 10 oktober 2026

De volledige matrix met 1, 2, 4 en 8 overdrachten is uitgevoerd op Linux/Node 24.19.0, met echte TCP-verbindingen naar een FTP-testserver op 127.0.0.1. Alle **8.128 uitvoerbestanden** zijn afzonderlijk met SHA-256 gecontroleerd. Alle 16 scenario’s slaagden; de gemeten verbindingen en gelijktijdige overdrachten bleven binnen hun ingestelde limieten. Navigatie gebruikte een afzonderlijke verbinding en gaf geen fouten.

De testserver bewaart data in RAM. Lokale staging gebruikt echte bestanden. De wachtrij gebruikte in deze nulmeting volledige JSON-snapshots in geheugen, dus geen SQLite/fsync. De control-socket van de testserver had TCP_NODELAY aan. De client gebruikte de bestaande volledige maplisting voor metadatacontroles; de latere MLST- en wachtrijoptimalisaties zijn hier nog niet opgenomen.

| Dataset | Richting | 1 tegelijk | 2 tegelijk | 4 tegelijk | 8 tegelijk |
|---|---|---:|---:|---:|---:|
| 1.000 × 4 KiB | Upload | 121,46 s | 121,26 s | 129,15 s | 129,20 s |
| 1.000 × 4 KiB | Download | 88,34 s | 98,81 s | 95,02 s | 89,36 s |
| 16 × 1 MiB | Upload | 0,70 s | 0,77 s | 0,57 s | 0,87 s |
| 16 × 1 MiB | Download | 1,79 s | 1,56 s | 1,47 s | 1,09 s |

De tijd omvat inplannen en afronden, niet het maken van de dataset of de afsluitende SHA-256-controle. Iedere rij/instelling is één meting op een gedeelde ontwikkelhost; gelijktijdige ontwikkeltests kunnen de resultaten beïnvloeden. Dit bepaalt geen optimaal productieprofiel en bevat geen TLS/SSH-, internet-, hostingdisk- of Windowsmeting.

Bij 1.000 uploads werd ongeveer 5,09 GB aan wachtrij-JSON geserialiseerd in 5.003 opslagaanroepen. Bovendien vonden 6.003 volledige wachtrijmeldingen plaats. Deze observatie, samen met herhaalde volledige listings voor bestandsmetadata, motiveert gerichte optimalisatie. Duurzame transactiefasen en actuele conflictcontroles moeten daarbij behouden blijven.

De ruwe uitkomsten met CPU, geheugen, navigatielatentie en opslagmetingen staan in [ftp-baseline.json](benchmarks/ftp-baseline.json). Een volgende meting moet de gebruikte opslag en MLST-instelling expliciet aangeven. Alleen vergelijkbare scenario’s mogen als voor/na-vergelijking worden gebruikt.

Reproduceren van de dataset en oorspronkelijke fixture-instelling:

```sh
npm run benchmark:transfers -- --control-no-delay --output artifacts/benchmark-transfers.json
```

De codeversie beïnvloedt dit resultaat: een nieuwe run met gewijzigde wachtrijcode is geen herhaling van dezelfde implementatie. De volledige nulmeting liep vóór de incrementele wachtrijopslag en globale UI-coalescer werden toegevoegd.

## Meting met MLST en incrementele SQLite-opslag

Daarna is dezelfde volledige dataset opnieuw overgedragen met MLST-ondersteuning in de testserver, de nieuwe globale UI-coalescer en het echte SQLite-journaal (WAL + synchronous=FULL). Alle 16 scenario’s en alle **8.128 SHA-256-inhoudscontroles** slaagden. Navigatie bleef foutloos en sessielimieten werden gerespecteerd.

| Dataset | Richting | 1 tegelijk | 2 tegelijk | 4 tegelijk | 8 tegelijk |
|---|---|---:|---:|---:|---:|
| 1.000 × 4 KiB | Upload | 26,26 s | 37,94 s | 28,25 s | 35,01 s |
| 1.000 × 4 KiB | Download | 6,13 s | 4,81 s | 4,70 s | 4,50 s |
| 16 × 1 MiB | Upload | 0,61 s | 0,49 s | 0,42 s | 0,41 s |
| 16 × 1 MiB | Download | 0,18 s | 0,19 s | 0,18 s | 0,19 s |

Per duizend uploads werd nu circa 6,17 MB gewijzigde record-JSON aangeboden in 5.001 opslagtransacties, tegenover circa 5,09 GB volledige snapshots eerder. Duurzame faseovergangen worden nog steeds onmiddellijk opgeslagen; alleen UI-meldingen worden gebundeld. De uploads blijven verse listings gebruiken wanneer MLST 550 teruggeeft: deze fout betekent niet betrouwbaar dat een doel ontbreekt.

Dit meet de **gezamenlijke wijziging** van metadataverzoeken, UI-meldingen en opslagbackend. De afzonderlijke bijdrage van MLST of SQLite is niet geïsoleerd. Het is nog steeds één run per instelling op een gedeelde ontwikkelhost; de verschillen tussen paralleliteitsinstellingen vormen geen betrouwbaar algemeen optimum. De standaard blijft daarom vier gelijktijdige overdrachten, configureerbaar per server.

SQLite-databaseaanmaak/migratie en sluiten/checkpoint vallen buiten de gemeten overdrachtstijd; de FULL-transacties tijdens overdrachten vallen erbinnen. `commitMs` omvat SQLite-serialisatie en transactie; `serializationMs` telt bij SQLite alleen de extra meetserialisatie. Dat verschilt van de memory-metingen en mag niet rechtstreeks als dezelfde kostenpost worden vergeleken.

Ruwe resultaten: [ftp-optimized.json](benchmarks/ftp-optimized.json).

```sh
npm run benchmark:transfers -- --mlst --store sqlite --control-no-delay --output artifacts/benchmark-optimized.json
```
