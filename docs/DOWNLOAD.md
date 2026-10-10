# Windows-checkpoint downloaden

Dit downloadpakket hoort bij broncheckpoint `e5022c9cb80a52c8711a012bd4b3120c05e3da0c`.
Het is een niet-ondertekende Windows x64-ontwikkelbuild, op Linux verpakt en nog niet op Windows uitgevoerd. Latere bronwijzigingen zitten niet automatisch in dit pakket.

De rechtstreekse workspace-link werkte bij de gebruiker niet. De Google Drive-uploadroute weigert bestanden groter dan 100 MiB. Daarom is een kopie van de ZIP in twee binaire delen gesplitst; de oorspronkelijke ZIP bleef ongewijzigd.

1. Download [deel 1](https://drive.google.com/file/d/1d9HXe6C4YkndDej1s9VNtAHRabmFqUgu/view) en [deel 2](https://drive.google.com/file/d/1hzYOIDhUbj7yuOPyZIy6kamOr9yAnCkA/view).
2. Bewaar beide bestanden in dezelfde map, met hun oorspronkelijke namen.
3. Open die map in Verkenner, typ `cmd` in de adresbalk en druk op Enter.
4. Voer onderstaande opdracht uit in Opdrachtprompt:

```bat
copy /b "FTP-Studio-win-x64.zip.001"+"FTP-Studio-win-x64.zip.002" "FTP-Studio-win-x64.zip"
```

5. Pak de gemaakte ZIP volledig uit. Start daarna `FTP Studio.exe` uit de uitgepakte map.

De uploadacties zijn voltooid en via Drive-metadata opnieuw gecontroleerd: deel 1 is 83.886.080 bytes en deel 2 is 78.912.277 bytes. Er zijn geen openbare deelrechten ingesteld. De gebruiker moet toegang hebben via het gekoppelde Drive-account. De gebruiker heeft bevestigd dat beide downloads werken. Windows-uitvoering is nog niet gecontroleerd.

## Integriteit

De samengevoegde ZIP is 162.798.357 bytes. De SHA-256 van de opeenvolgende delen komt overeen met die van de originele ZIP:

```text
1abf46b57a49885fc5c7c81c59b3c137d0f4b121724d97a4acfedb994ddaeead
```

Controle op Windows, in dezelfde Opdrachtprompt:

```bat
certutil -hashfile "FTP-Studio-win-x64.zip" SHA256
```

SHA-256 per downloaddeel:

```text
21035dfe04adb5f43b6db1efcaf3e8d15562befc960b966832300afaa9960cb6  FTP-Studio-win-x64.zip.001
6d84759e9b5bfb80c8861d8c66b7fed33641397b345c6e93566254344bf6e25f  FTP-Studio-win-x64.zip.002
```
