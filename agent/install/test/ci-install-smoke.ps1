# CI install-smoke (Windows): prove install.ps1 PARSES + VERIFIES + INSTALLS the
# freshly-built .exe against a locally-signed mock release. Used by agent-ci.yml on
# windows-latest. Requires minisign and rustc on PATH. The installer runs in the
# same PowerShell as this script (pwsh in CI; Windows PowerShell works too).
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$powershell = (Get-Process -Id $PID).Path
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
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if (-not (Test-Path (Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.exe'))) {
    throw "install did not place the binary"
  }
  Write-Host "install-smoke OK: verified + installed $asset"

  # A pinned GitHub Release URL is already the asset directory. Exercise the
  # documented fallback shape so the installer cannot silently append the edge
  # /agent/v<version> path a second time.
  $releaseVersion = (& $built --version).Split()[-1]
  $direct = Join-Path $work "github\releases\download\agent-v$releaseVersion"
  New-Item -ItemType Directory -Path $direct -Force | Out-Null
  Copy-Item (Join-Path $mock $asset) $direct
  Copy-Item (Join-Path $mock "$asset.sha256") $direct
  Copy-Item (Join-Path $mock "$asset.minisig") $direct
  $env:OPENGENI_INSTALL_BASE_URL = "file://$($direct -replace '\\','/')"
  $env:OPENGENI_AGENT_VERSION = $releaseVersion
  $env:OPENGENI_INSTALL_DIR = Join-Path $work 'direct-bin'
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  $directAgent = Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.exe'
  if (-not (Test-Path $directAgent) -or (& $directAgent --version) -ne (& $built --version)) {
    throw "direct GitHub Release fallback installed the wrong agent"
  }
  Remove-Item Env:OPENGENI_AGENT_VERSION -ErrorAction SilentlyContinue
  $env:OPENGENI_INSTALL_BASE_URL = "file://$($work -replace '\\','/')/mock"
  Write-Host "install-smoke OK: direct GitHub Release fallback verified + installed"

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
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if ((& $newerExe --version) -ne 'opengeni-agent 9.9.9') {
    throw "lagging installer replaced a newer installed agent"
  }
  Write-Host "install-smoke OK: newer installed agent preserved"

  $env:OPENGENI_ALLOW_DOWNGRADE = '1'
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if ((& $newerExe --version) -ne (& $built --version)) {
    throw "explicit downgrade override did not install the verified candidate"
  }
  Remove-Item Env:OPENGENI_ALLOW_DOWNGRADE -ErrorAction SilentlyContinue
  Write-Host "install-smoke OK: explicit downgrade override honored"

  # An agent this machine cannot start (here one exiting with
  # STATUS_DLL_NOT_FOUND, as a build needing a missing Visual C++ runtime does)
  # is refused before it replaces the installed agent (exit 8), and the reason
  # carries its exit code.
  $brokenSource = Join-Path $work 'broken-agent.rs'
  'fn main() { std::process::exit(-1073741515); }' | Set-Content $brokenSource
  $brokenExe = Join-Path $work 'broken-agent.exe'
  & rustc $brokenSource -o $brokenExe
  if ($LASTEXITCODE -ne 0) { throw "could not compile broken-agent fixture" }
  $brokenMock = Join-Path $work 'broken\agent\latest'
  New-Item -ItemType Directory -Path $brokenMock -Force | Out-Null
  Copy-Item $brokenExe (Join-Path $brokenMock $asset)
  & minisign -S -W -s (Join-Path $work 'k.key') -m (Join-Path $brokenMock $asset) | Out-Null
  $brokenHash = (Get-FileHash -Algorithm SHA256 (Join-Path $brokenMock $asset)).Hash.ToLowerInvariant()
  "$brokenHash  $asset" | Set-Content (Join-Path $brokenMock "$asset.sha256")
  $env:OPENGENI_INSTALL_BASE_URL = "file://$($work -replace '\\','/')/broken"
  $env:OPENGENI_INSTALL_DIR = Join-Path $work 'bin'
  $installed = Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.exe'
  $installedHash = (Get-FileHash -Algorithm SHA256 $installed).Hash
  $refusal = & $powershell -NoProfile -ExecutionPolicy Bypass -File $script | Out-String
  $rc = $LASTEXITCODE
  if ($rc -ne 8) { throw "an agent that cannot start was NOT refused (rc=$rc, expected 8): $refusal" }
  if ($refusal -notmatch '0xC0000135') { throw "the refusal does not name the exit code: $refusal" }
  if ((Get-FileHash -Algorithm SHA256 $installed).Hash -ne $installedHash) {
    throw "the refused agent replaced the installed one"
  }
  if (Test-Path (Join-Path $env:OPENGENI_INSTALL_DIR 'opengeni-agent.new.exe')) {
    throw "the refused agent was left staged in the install directory"
  }
  Write-Host "install-smoke OK: an agent that cannot start is refused (rc=8)"

  # An installed agent that cannot report its version is repaired by the
  # verified candidate instead of blocking it.
  Copy-Item $brokenExe $installed -Force
  $env:OPENGENI_INSTALL_BASE_URL = "file://$($work -replace '\\','/')/mock"
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if ($LASTEXITCODE -ne 0 -or (& $installed --version) -ne (& $built --version)) {
    throw "an installed agent that cannot start was not repaired"
  }
  Write-Host "install-smoke OK: an installed agent that cannot start is repaired"

  # A tampered artifact MUST be rejected (exit 5).
  Add-Content (Join-Path $mock $asset) 'TAMPER'
  $hash2 = (Get-FileHash -Algorithm SHA256 (Join-Path $mock $asset)).Hash.ToLowerInvariant()
  "$hash2  $asset" | Set-Content (Join-Path $mock "$asset.sha256")
  $env:OPENGENI_INSTALL_DIR = Join-Path $work 'bin2'
  & $powershell -NoProfile -ExecutionPolicy Bypass -File $script
  if ($LASTEXITCODE -ne 5) { throw "tampered artifact NOT rejected (rc=$LASTEXITCODE, expected 5)" }
  Write-Host "install-smoke OK: tampered artifact rejected (rc=5)"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
