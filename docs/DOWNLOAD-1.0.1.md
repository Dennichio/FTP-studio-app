# FTP Studio 1.0.1 downloaden

De geteste app hoort bij broncommit `20a3b11ca1969f2c7ee02d60c474153a826b4106`.

- [Deel 1 — 83.886.080 bytes](https://drive.google.com/file/d/1-RlhAdC9MO-YIRXOrVZStm3zheSvH-4l/view?usp=drivesdk)
- [Deel 2 — 78.921.725 bytes](https://drive.google.com/file/d/1QPlKoj4b1602yRkVPuBvRVJryeznhQM4/view?usp=drivesdk)

Bewaar beide delen in dezelfde map. Open daar Opdrachtprompt (`cmd`) en voer uit:

```bat
copy /b "FTP-Studio-1.0.1-win-x64.zip.001"+"FTP-Studio-1.0.1-win-x64.zip.002" "FTP-Studio-1.0.1-win-x64.zip"
```

Sluit de oude app. Pak de volledige ZIP uit in een nieuwe map en start `FTP Studio.exe`. De gebruikersgegevens blijven in dezelfde afzonderlijke gebruikersmap.

De delen zijn geüpload en met Drive-metadata opnieuw gecontroleerd. Hun reconstructie is bytegelijk aan de geteste ZIP. SHA-256: `bbeb85dd2ae1581f72495a4aef9e6e9c88cae7dd41c067f14ee60a9673ddbcf8`.

De broncode staat op GitHub. De GitHub-release `v1.0.1` blijft een concept zonder assets: de normale repository-API en Git-push werken, maar `uploads.github.com` gaf HTTP 401 Bad credentials bij de upload. Daarom wordt de binary via Drive geleverd. Er zijn geen publieke Drive-deelrechten toegevoegd. De app is op Linux gebouwd/getest; Windows-uitvoering is niet in deze omgeving gecontroleerd.
