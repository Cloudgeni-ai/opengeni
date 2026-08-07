# CI install-smoke (Windows): prove install.ps1 PARSES + VERIFIES + INSTALLS the
# freshly-built .exe against a locally-signed mock release. Used by agent-ci.yml on
# windows-latest. Requires minisign on PATH.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$asset = 'opengeni-agent-x86_64-pc-windows-msvc.exe'
$built = Join-Path $agentDir 'target\release\opengeni-agent.exe'
if (-not (Test-Path $built)) { throw "built binary not found at $built" }

$work = Join-Path $env:TEMP ("og-smoke-" + [guid]::NewGuid())
$mock = Join-Path $work 'mock\agent\latest'
New-Item -ItemType Directory -Path $mock -Force | Out-Null
try {
  Copy-Item $built (Join-Path $mock $asset)

  # Throwaway key + sign + checksum.
  & minisign -G -W -p (Join-Path $work 'k.pub') -s (Join-Path $work 'k.key') | Out-Null
  & minisign -S -W -s (Join-Path $work 'k.key') -m (Join-Path $mock $asset) | Out-Null
  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $mock $asset)).Hash.ToLowerInvariant()
  "$hash  $asset" | Set-Content (Join-Path $mock "$asset.sha256")

  # A copy of install.ps1 with the throwaway pubkey pinned.
  $pub = (Get-Content (Join-Path $work 'k.pub'))[1]
  $script = Join-Path $work 'install.ps1'
  (Get-Content (Join-Path $agentDir 'install\install.ps1')) `
    -replace "^\`$OPENGENI_MINISIGN_PUBKEY = .*", "`$OPENGENI_MINISIGN_PUBKEY = '$pub'" |
    Set-Content $script

  $env:OPENGENI_INSTALL_BASE_URL = "file://$($work -replace '\\','/')/mock"
  $env:OPENGENI_INSTALL_DIR = Join-Path $work 'bin'
  $env:OPENGENI_NO_SERVICE = '1'
  & pwsh -File $script
  if (-not (Test-Path (Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.exe'))) {
    throw "install did not place the binary"
  }
  Write-Host "install-smoke OK: verified + installed $asset"

  # Compile a tiny executable that reports a future version, place it at the
  # shared install path, and prove a lagging deployment cannot replace it unless
  # the operator explicitly opts into a downgrade.
  $newerDir = Join-Path $work 'newer-bin'
  New-Item -ItemType Directory -Path $newerDir -Force | Out-Null
  $newerSource = Join-Path $work 'newer-agent.rs'
  'fn main() { println!("opengeni-agent 9.9.9"); }' | Set-Content $newerSource
  $newerExe = Join-Path $newerDir 'opengeni-agent.exe'
  & rustc $newerSource -o $newerExe
  if ($LASTEXITCODE -ne 0) { throw "could not compile newer-agent fixture" }

  $env:OPENGENI_INSTALL_DIR = $newerDir
  Remove-Item Env:OPENGENI_ALLOW_DOWNGRADE -ErrorAction SilentlyContinue
  & pwsh -File $script
  if ((& $newerExe --version) -ne 'opengeni-agent 9.9.9') {
    throw "lagging installer replaced a newer installed agent"
  }
  Write-Host "install-smoke OK: newer installed agent preserved"

  $env:OPENGENI_ALLOW_DOWNGRADE = '1'
  & pwsh -File $script
  if ((& $newerExe --version) -ne (& $built --version)) {
    throw "explicit downgrade override did not install the verified candidate"
  }
  Remove-Item Env:OPENGENI_ALLOW_DOWNGRADE -ErrorAction SilentlyContinue
  Write-Host "install-smoke OK: explicit downgrade override honored"

  # A tampered artifact MUST be rejected (exit 5).
  Add-Content (Join-Path $mock $asset) 'TAMPER'
  $hash2 = (Get-FileHash -Algorithm SHA256 (Join-Path $mock $asset)).Hash.ToLowerInvariant()
  "$hash2  $asset" | Set-Content (Join-Path $mock "$asset.sha256")
  $env:OPENGENI_INSTALL_DIR = Join-Path $work 'bin2'
  & pwsh -File $script
  if ($LASTEXITCODE -ne 5) { throw "tampered artifact NOT rejected (rc=$LASTEXITCODE, expected 5)" }
  Write-Host "install-smoke OK: tampered artifact rejected (rc=5)"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
