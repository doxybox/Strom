# Laster ned Electron (kjøremiljøet til Strøm) fra Electrons offisielle side og sjekker kontrollsummen.
param([string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Versjon = '44.10.2'
$Sha256 = '7AF18E85A1537B832924AE3B0E5146602F2F4F4B0C77C74E4AE0DC251CA338F9'
$Url = "https://github.com/electron/electron/releases/download/v$Versjon/electron-v$Versjon-win32-x64.zip"
$Zip = Join-Path $env:TEMP "strom-electron-$Versjon.zip"
try {
  if (-not (Test-Path $Zip) -or ((Get-FileHash $Zip -Algorithm SHA256).Hash -ne $Sha256)) {
    Write-Output "Laster ned kjøremiljø (Electron $Versjon, ca. 150 MB) ..."
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('User-Agent', 'Strom-installer')
    $wc.DownloadFile($Url, $Zip)
  }
  Write-Output 'Kontrollerer at filen er ekte (SHA-256) ...'
  $hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
  if ($hash -ne $Sha256) { Remove-Item $Zip -Force; Write-Output "Feil kontrollsum: $hash"; exit 2 }
  Write-Output 'Pakker ut ...'
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $Zip -C $Dest; if ($LASTEXITCODE -ne 0) { throw "tar feilet ($LASTEXITCODE)" } }
  else { Expand-Archive -Path $Zip -DestinationPath $Dest -Force }
  Remove-Item $Zip -Force -ErrorAction SilentlyContinue
  Write-Output 'Kjøremiljø installert.'
  exit 0
} catch {
  Write-Output "Feil: $($_.Exception.Message)"
  exit 1
}


