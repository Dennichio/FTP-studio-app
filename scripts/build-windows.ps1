$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Installeer Node.js 24 LTS voordat u bouwt.' }
if (Test-Path package-lock.json) { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) { throw 'Dependency-installatie mislukt.' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecontrole mislukt.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests mislukt.' }
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw 'Windows-build mislukt.' }
Write-Host 'Distributie staat in release/. Pak de ZIP volledig uit en start FTP Studio.exe.'
