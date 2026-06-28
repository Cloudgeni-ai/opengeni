# CI install-smoke (Windows): prove install.ps1 PARSES + VERIFIES + INSTALLS the
# freshly-built .exe against a locally-signed mock release. Used by agent-ci.yml on
# windows-latest (dossier §23.3). Requires minisign on PATH.
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
  $env:OPENGENI_NO_RUN = '1'
  & pwsh -File $script
  if (-not (Test-Path (Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.exe'))) {
    throw "install did not place the binary"
  }
  Write-Host "install-smoke OK: verified + installed $asset"

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
