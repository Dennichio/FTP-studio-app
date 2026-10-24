# FTP Studio 1.0.1 — overdrachten en wachtrij

- Handmatig uploaden en downloaden vanuit de geopende lokale map, ook buiten de lokale hoofdmap van het verbindingsprofiel. Deze gekozen map wordt per opdracht bewaard, ook voor opnieuw proberen en herstel na herstart. Pad-, symlink-, gevoelige-bestanden- en servercontroles blijven gelden.
- Conflicten, fouten en afgeronde opdrachten kunnen afzonderlijk uit de wachtrij worden verwijderd. Bij een onderbroken bestandswissel blijven herstelgegevens en tijdelijke/reservebestanden bewaard; alleen de zichtbare wachtrijregel verdwijnt. Ook de centrale wisknop werkt hiervoor.
- Direct zichtbare voorbereiding bij upload/download, met bescherming tegen dubbel klikken en een melding wanneer filters alle items uitsluiten.
- Grote selecties worden in groepen van 16 geselecteerde items ingepland. De eerste overdrachten kunnen starten terwijl volgende groepen worden gecontroleerd. Er wordt niet eerst voor de hele selectie een dubbele servermetadatacontrole uitgevoerd.
- Bij een fout in een latere groep blijven eerder ingeplande opdrachten bestaan. De melding vermeldt dit uitdrukkelijk. Een afzonderlijke map wordt nog volledig gecontroleerd voordat haar inhoud wordt ingepland.
- De eerder ontwikkelde virtualisatie van grote wachtrijen en logboeken is inbegrepen.

## Installatie

Sluit FTP Studio af. Pak de volledige nieuwe ZIP uit in een aparte map en start `FTP Studio.exe`. De app blijft dezelfde gebruikersgegevensmap gebruiken; verwijder die map niet. Dit is een niet-ondertekende zelfstandige Windows x64-ontwikkelbuild. De regressietests zijn uitgevoerd op Linux/Electron; Windows-uitvoering is niet in deze ontwikkelomgeving getest.
