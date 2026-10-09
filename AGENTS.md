# FTP Studio — werkafspraken

De functionele opdracht van de gebruiker is leidend. UI en meldingen zijn Nederlands.
Geen mocks in productie, geen fictieve testresultaten, geen stille broncodeherschrijving.

## Modelverdeling
- Categorie A: gpt-6-astra (high) voor overdrachtsintegriteit, broncodepatches en onafhankelijke beveiligingsreview.
- Categorie B: gpt-6.1-sol (high) voor protocollen, projectdiensten en interface.
- Categorie C: gpt-6-luna voor afgebakende documentatie, indien efficiënt.
- De hoofdagent integreert en test. B/C-code wordt vóór definitieve integratie door A gereviewd.
- Dit zijn beschikbaar gestelde modelnamen; daadwerkelijke delegatie staat in PROGRESS.md.

## Eigenaarschap en integratie
Gedeelde types staan in src/shared/contracts.ts en worden uitsluitend door de hoofdagent gewijzigd.
Agents werken in toegewezen bestanden, communiceren interfacewijzigingen en wijzigen geen andermans bestanden.
Schrijf echte unit- en integratietests voor risicovolle gedragingen. Tests gebruiken tijdelijke mappen en lokale testservers.
Geen productiecredentials, externe publicaties of automatische remote verwijdering.
Credentials uitsluitend via Electron safeStorage/Windows DPAPI; geen geheimen in SQLite of logs.
Symlinks, padontsnapping, onbekende SSH-hostsleutels en ongeldige TLS-certificaten worden geweigerd.
Bij twijfel over veilig visueel bewerken: blokkeren met uitleg, oorspronkelijke bron bewaren.
Documenteer onbewezen platformclaims en ontbrekende functionaliteit expliciet.
