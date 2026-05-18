# build.ps1 — Silicon-only build driver for sigil (Windows / PowerShell).
#
# Rebuilds wasm-bin/stage1.wasm from the boot/*.si tree using ONLY:
#   - wasmtime (>= 14)  on PATH
#   - wat2wasm (wabt)   on PATH
#
# No bun, no node, no typescript.  Mirror of build.sh; keep the two in
# sync when STAGE1_FILES or the WASI stub change.
#
# Usage:
#   ./build.ps1                       # rebuild wasm-bin/stage1.wasm in-place
#   ./build.ps1 test                  # build, then announce that the runner is pending
#   ./build.ps1 check                 # build into a temp path, fixed-point check

[CmdletBinding()]
param([string]$Command = 'build')

$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

$WasmBin = Join-Path $ProjectRoot 'wasm-bin'
$Seed    = Join-Path $WasmBin    'stage1.wasm'
$OutWat  = Join-Path $WasmBin    'stage1.wat'
$OutWasm = Join-Path $WasmBin    'stage1.wasm'
$TmpWat  = [System.IO.Path]::GetTempFileName() + '.wat'
$TmpWasm = [System.IO.Path]::GetTempFileName() + '.wasm'

function Require-Tool($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "build.ps1: missing required tool '$name'`n  install via: $hint"
    exit 127
  }
}

Require-Tool 'wasmtime' 'https://wasmtime.dev/install.sh (or choco install wasmtime)'
Require-Tool 'wat2wasm' 'https://github.com/WebAssembly/wabt/releases (choco install wabt)'

if (-not (Test-Path $Seed)) {
  Write-Error "build.ps1: seed compiler $Seed not found.`n  Restore via git."
  exit 2
}

# Bundle order — MUST match scripts/build-stage1.ts:STAGE1_FILES and
# build.sh:STAGE1_FILES for byte-equal output.
$Stage1Files = @(
  'boot/std/argv.si'
  'boot/std/io.si'
  'boot/std/fs.si'
  'boot/std/arena.si'
  'boot/std/vec.si'
  'boot/embedded_bundle.si'
  'boot/parser/tokens.si'
  'boot/parser/lex.si'
  'boot/parser/ast.si'
  'boot/parser/parse.si'
  'boot/strata/registry.si'
  'boot/strata/loader.si'
  'boot/elab/elaborator.si'
  'boot/ir/nodes.si'
  'boot/elab/body.si'
  'boot/ir/lower.si'
  'boot/emit/wat.si'
  'boot/cli.si'
  'boot/stage1.si'
)

# Must be lexically identical to scripts/build-stage1.ts:WASI_STUB and
# build.sh:emit_wasi_stub.
$WasiStub = @'
@extern wasi_snapshot_preview1::fd_write:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;
@extern wasi_snapshot_preview1::fd_read:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;
@extern wasi_snapshot_preview1::args_get:Int
  argv_ptr:Int, argv_buf:Int;
@extern wasi_snapshot_preview1::args_sizes_get:Int
  argc_out:Int, argv_buf_size_out:Int;
@extern wasi_snapshot_preview1::proc_exit
  code:Int;
@extern wasi_snapshot_preview1::path_open:Int
  dirfd:Int, dirflags:Int, path_ptr:Int, path_len:Int,
  oflags:Int, fs_rights_base:Int64, fs_rights_inheriting:Int64,
  fdflags:Int, fd_out:Int;
@extern wasi_snapshot_preview1::fd_prestat_get:Int
  fd:Int, buf_out:Int;
@extern wasi_snapshot_preview1::fd_prestat_dir_name:Int
  fd:Int, path_ptr:Int, path_len:Int;
'@

function Assemble-Bundle {
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append($WasiStub)
  [void]$sb.Append("`n")
  foreach ($f in $Stage1Files) {
    $path = Join-Path $ProjectRoot $f
    if (-not (Test-Path $path)) { throw "build.ps1: missing $f" }
    [void]$sb.Append((Get-Content -Raw -LiteralPath $path -Encoding utf8))
  }
  $sb.ToString()
}

function Build-Stage1 {
  Write-Host "build.ps1: bundling $($Stage1Files.Count) source files…"
  $bundle = Assemble-Bundle
  Write-Host 'build.ps1: compiling via stage1.wasm under wasmtime…'
  # Use --% to stop PowerShell from rewriting args; pipe UTF-8 bytes
  # so multi-byte source characters survive.
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $bytes = $utf8.GetBytes($bundle)
  $bundleTmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllBytes($bundleTmp, $bytes)
  try {
    cmd /c "wasmtime --dir . `"$Seed`" < `"$bundleTmp`" > `"$TmpWat`""
    if ($LASTEXITCODE -ne 0) { throw "stage1.wasm compile failed (exit $LASTEXITCODE)" }
    Write-Host 'build.ps1: assembling WAT → WASM via wat2wasm…'
    wat2wasm $TmpWat -o $TmpWasm
    if ($LASTEXITCODE -ne 0) { throw "wat2wasm failed (exit $LASTEXITCODE)" }
  } finally {
    Remove-Item -LiteralPath $bundleTmp -ErrorAction SilentlyContinue
  }
}

try {
  switch ($Command) {
    'build' {
      Build-Stage1
      Copy-Item -LiteralPath $TmpWat  -Destination $OutWat  -Force
      Copy-Item -LiteralPath $TmpWasm -Destination $OutWasm -Force
      $watLen  = (Get-Item $OutWat).Length
      $wasmLen = (Get-Item $OutWasm).Length
      Write-Host "build.ps1: ✓ wrote $OutWat ($watLen bytes)"
      Write-Host "build.ps1: ✓ wrote $OutWasm ($wasmLen bytes)"
    }
    'check' {
      Build-Stage1
      $seedHash = (Get-FileHash -Path $Seed -Algorithm SHA256).Hash
      $newHash  = (Get-FileHash -Path $TmpWasm -Algorithm SHA256).Hash
      if ($seedHash -eq $newHash) {
        Write-Host 'build.ps1: ✓ fixed point — rebuilt stage1.wasm byte-equal to seed'
      } else {
        Write-Error "build.ps1: ✗ fixed-point FAILED`n  seed: $((Get-Item $Seed).Length) bytes`n  new:  $((Get-Item $TmpWasm).Length) bytes"
        exit 1
      }
    }
    'test' {
      Build-Stage1
      Copy-Item -LiteralPath $TmpWat  -Destination $OutWat  -Force
      Copy-Item -LiteralPath $TmpWasm -Destination $OutWasm -Force
      Write-Host 'build.ps1: build complete; test runner not yet ported (Phase 6)'
    }
    default {
      Write-Error "build.ps1: unknown subcommand '$Command'`nUsage: ./build.ps1 [build|check|test]"
      exit 64
    }
  }
} finally {
  Remove-Item -LiteralPath $TmpWat,$TmpWasm -ErrorAction SilentlyContinue
}
