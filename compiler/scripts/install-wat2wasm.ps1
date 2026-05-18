# scripts/install-wat2wasm.ps1 — fetch the standalone wat2wasm binary
# from the wabt release tree into .\bin\.  Used by build.ps1 and the
# Silicon-only shell pipeline so the user doesn't have to install wabt
# system-wide.
#
# Idempotent: skips the download if .\bin\wat2wasm.exe already exists
# and runs.
#
# Override the version pinned below by setting $env:WABT_VERSION
# before running.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $ProjectRoot

$WabtVersion = if ($env:WABT_VERSION) { $env:WABT_VERSION } else { '1.0.36' }
$BinDir = Join-Path $ProjectRoot 'bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

$ExePath = Join-Path $BinDir 'wat2wasm.exe'
if (Test-Path $ExePath) {
  try {
    $ver = & $ExePath --version 2>$null
    Write-Host "wat2wasm already installed: $ver"
    exit 0
  } catch { } # fall through to re-install
}

# Asset name follows WebAssembly/wabt's release pipeline; if a future
# wabt release changes the suffix, set $env:WABT_ASSET to override.
$Asset = if ($env:WABT_ASSET) { $env:WABT_ASSET } else { "wabt-$WabtVersion-windows.tar.gz" }
$Url   = "https://github.com/WebAssembly/wabt/releases/download/$WabtVersion/$Asset"
$Tmp   = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ([System.IO.Path]::GetRandomFileName())

try {
  $Archive = Join-Path $Tmp.FullName 'wabt.tar.gz'
  Write-Host "install-wat2wasm.ps1: downloading $Asset"
  # Modern PowerShell ships tar.exe (Windows 10+).  Invoke-WebRequest
  # for the download — Curl is also bundled but Invoke-WebRequest is
  # idiomatic and works on all supported PowerShell versions.
  Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing

  Write-Host 'install-wat2wasm.ps1: extracting'
  tar -xzf $Archive -C $Tmp.FullName
  if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }

  $found = Get-ChildItem -Path $Tmp.FullName -Recurse -Filter 'wat2wasm.exe' | Select-Object -First 1
  if (-not $found) { throw 'wat2wasm.exe not found in archive' }
  Copy-Item -Path $found.FullName -Destination $ExePath -Force

  Write-Host "install-wat2wasm.ps1: ✓ installed to $ExePath"
  & $ExePath --version
} finally {
  Remove-Item -Path $Tmp.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
