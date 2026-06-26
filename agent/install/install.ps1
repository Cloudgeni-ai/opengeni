<#
.SYNOPSIS
  OpenGeni self-hosted agent installer — Windows (PowerShell 5.1+ / 7+).

.DESCRIPTION
  irm https://get.opengeni.ai/install.ps1 | iex

  READ THIS BEFORE PIPING IT TO iex. This script downloads the opengeni-agent.exe
  for your arch, VERIFIES it two independent ways (a minisign signature against a
  public key PINNED in this script's body, AND a sha256 checksum), installs it to
  a per-user path, adds that path to your user PATH, and then PRINTS the exact
  command to enroll + run it. It installs NO Windows Service by default and
  contains NO secrets. The pinned public key travels WITH this audited script, so
  a compromised CDN cannot serve a binary that verifies.

  Run model (dossier §23.0): the default is a FOREGROUND `opengeni-agent run`. An
  always-on Windows Service is an explicit opt-in (`opengeni-agent service
  install`), never installed by this script. This script is rename-running-exe
  aware: a re-install over a running agent renames the live .exe aside before
  placing the new one (the same trick self-update uses).

.PARAMETER -* (environment overrides, all optional)
  OPENGENI_INSTALL_BASE_URL  Release asset base URL (default https://get.opengeni.ai).
                             Point at a local mock (http://localhost/...) to test offline.
  OPENGENI_AGENT_VERSION     Pin a version (default "latest").
  OPENGENI_INSTALL_DIR       Install dir (default %LOCALAPPDATA%\OpenGeni\bin).
  OPENGENI_ENROLL_TOKEN      Non-interactive enroll token (CI/automation).
  OPENGENI_NO_RUN            "1" => do not start a foreground run; just print the command.
  OPENGENI_API_URL           Control-plane API base URL for enrollment.

  Immutable-per-version + GitHub-Releases fallback: assets resolve to
  $BASE/agent/v<ver>/<asset>. If the edge is down, the same assets are mirrored at
  https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v<ver>/<asset>.

  Exit codes mirror install.sh: 0 ok, 2 usage, 3 download, 4 checksum, 5 signature,
  6 no-verify-tool, 7 unsupported-arch.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The PINNED minisign public key (the base64 line of opengeni-agent-minisign.pub).
# Trust root: a binary is rejected unless its .minisig verifies against THIS key.
$OPENGENI_MINISIGN_PUBKEY = 'RWTrFASYAF06Hp49HTGbUcHnqcujmRyJdNcgE/cDkrp8Ke3YwlVL/dT4'

function Get-EnvOr($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($v)) { return $default } else { return $v }
}

$BaseUrl = Get-EnvOr 'OPENGENI_INSTALL_BASE_URL' 'https://get.opengeni.ai'
$Version = Get-EnvOr 'OPENGENI_AGENT_VERSION' 'latest'

function Log($msg)  { Write-Host "opengeni-install: $msg" }
function Fail($code, $msg) { Write-Host "opengeni-install: ERROR: $msg" -ForegroundColor Red; exit $code }

function Get-Asset {
  # ARM64 vs x64. PROCESSOR_ARCHITECTURE is the running process arch; on WoW64 the
  # native arch is in PROCESSOR_ARCHITEW6432.
  $arch = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { return 'opengeni-agent-x86_64-pc-windows-msvc.exe' }
    'ARM64' { return 'opengeni-agent-aarch64-pc-windows-msvc.exe' }
    default { Fail 7 "unsupported Windows arch: $arch" }
  }
}

function Get-AssetUrl($name) {
  if ($Version -eq 'latest') { return "$BaseUrl/agent/latest/$name" }
  return "$BaseUrl/agent/v$Version/$name"
}

function Invoke-Download($url, $out) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  } catch {
    Fail 3 "failed to download $url : $($_.Exception.Message)"
  }
}

function Get-Sha256($file) {
  return (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
}

# Verify the minisign signature against the pinned key. Prefer the minisign.exe if
# present; otherwise a self-contained .NET ed25519 verify is NOT available on
# Windows PowerShell 5.1 (no Ed25519 in legacy .NET Framework), so we require
# minisign.exe OR a checksum-only fallback with a loud warning is NOT permitted —
# instead we fail closed asking the user to install minisign. On PowerShell 7+ we
# can use the .NET 5+ Ed25519... but to keep the contract simple + identical we
# standardize on the minisign binary when openssl is unavailable.
function Test-Signature($file, $sig) {
  $minisign = Get-Command minisign -ErrorAction SilentlyContinue
  if ($minisign) {
    & minisign -Vm $file -x $sig -P $OPENGENI_MINISIGN_PUBKEY 2>$null
    if ($LASTEXITCODE -ne 0) { Fail 5 "minisign signature verification FAILED for $(Split-Path $file -Leaf)" }
    Log "minisign signature verified (minisign.exe)"
    return
  }
  $openssl = Get-Command openssl -ErrorAction SilentlyContinue
  if ($openssl) {
    Test-SignatureOpenssl $file $sig
    return
  }
  Fail 6 "no signature-verify tool found. Install minisign (winget install jedisct1.minisign) or OpenSSL, then re-run."
}

# Pure-openssl ed25519 verify (mirrors install.sh's fallback): reconstruct the
# ed25519 key from the pinned base64, verify the signature over the file's
# BLAKE2b-512 prehash (minisign "ED" algorithm).
function Test-SignatureOpenssl($file, $sig) {
  $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("og-verify-" + [guid]::NewGuid())) -Force
  try {
    $pkBytes  = [Convert]::FromBase64String($OPENGENI_MINISIGN_PUBKEY)
    $pkRaw    = $pkBytes[10..41]                                   # 32-byte ed25519 key
    $sigLine  = (Get-Content $sig)[1]
    $sigBytes = [Convert]::FromBase64String($sigLine)
    $algo     = [System.Text.Encoding]::ASCII.GetString($sigBytes[0..1])
    $sigRaw   = $sigBytes[10..73]                                  # 64-byte signature

    $derPrefix = [byte[]](0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00)
    $der = $derPrefix + $pkRaw
    $derPath = Join-Path $tmp 'pk.der'; [IO.File]::WriteAllBytes($derPath, $der)
    $pemPath = Join-Path $tmp 'pk.pem'
    & openssl pkey -pubin -inform DER -in $derPath -out $pemPath 2>$null
    if ($LASTEXITCODE -ne 0) { Fail 5 "could not load the pinned ed25519 key into openssl" }

    $sigPath = Join-Path $tmp 'sig.raw'; [IO.File]::WriteAllBytes($sigPath, $sigRaw)
    $signed = $file
    if ($algo -eq 'ED') {
      $prehash = Join-Path $tmp 'prehash'
      & openssl dgst -blake2b512 -binary -out $prehash $file 2>$null
      if ($LASTEXITCODE -ne 0) { Fail 6 "openssl lacks BLAKE2b-512; install minisign to verify." }
      $signed = $prehash
    }
    & openssl pkeyutl -verify -pubin -inkey $pemPath -rawin -in $signed -sigfile $sigPath 2>$null
    if ($LASTEXITCODE -ne 0) { Fail 5 "ed25519 signature verification FAILED for $(Split-Path $file -Leaf)" }
    Log "minisign signature verified (openssl ed25519)"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Get-InstallDir {
  $d = Get-EnvOr 'OPENGENI_INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'OpenGeni\bin')
  return $d
}

function Add-UserPath($dir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$dir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $dir } else { "$userPath;$dir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Log "added $dir to your user PATH (open a new terminal to pick it up)"
  }
}

function Main {
  $asset = Get-Asset
  $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("og-install-" + [guid]::NewGuid())) -Force
  try {
    Log "installing $asset (version: $Version) from $BaseUrl"
    $binUrl = Get-AssetUrl $asset
    $binTmp = Join-Path $tmp $asset
    $shaTmp = "$binTmp.sha256"
    $sigTmp = "$binTmp.minisig"

    Log "downloading binary + checksum + signature"
    Invoke-Download $binUrl       $binTmp
    Invoke-Download "$binUrl.sha256" $shaTmp
    Invoke-Download "$binUrl.minisig" $sigTmp

    # GATE 1: checksum.
    $want = ((Get-Content $shaTmp -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $got  = Get-Sha256 $binTmp
    if ($want -ne $got) { Fail 4 "checksum mismatch: expected $want got $got" }
    Log "sha256 checksum OK"

    # GATE 2: signature against the pinned key (fail-closed).
    Test-Signature $binTmp $sigTmp

    # Install: rename-running-exe aware. If a previous .exe is running it holds a
    # lock; renaming the live exe aside is permitted, so a re-install never fails.
    $installDir = Get-InstallDir
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $dest = Join-Path $installDir 'opengeni-agent.exe'
    if (Test-Path $dest) {
      $aside = "$dest.old"
      Remove-Item -Force $aside -ErrorAction SilentlyContinue
      try { Move-Item -Force $dest $aside } catch { } # locked-running: rename aside
    }
    Move-Item -Force $binTmp $dest
    Log "installed verified binary to $dest"
    Add-UserPath $installDir

    Complete-Install $dest
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Complete-Install($bin) {
  Write-Host ""
  $enrollToken = [Environment]::GetEnvironmentVariable('OPENGENI_ENROLL_TOKEN')
  if (-not [string]::IsNullOrEmpty($enrollToken)) {
    Log "non-interactive enroll (OPENGENI_ENROLL_TOKEN set)"
    & $bin enroll --token $enrollToken --non-interactive
    Log "enrolled. Start the agent (foreground) with:  $bin run"
    return
  }

  Write-Host "opengeni-agent installed at: $bin"
  Write-Host ""
  Write-Host "Next steps (the agent runs in the FOREGROUND — it does NOT install a service):"
  Write-Host "  1. Enroll this machine:   $bin enroll"
  Write-Host "  2. Run it (online while this runs, offline when you stop it):"
  Write-Host "       $bin run"
  Write-Host ""
  Write-Host "Want an always-on machine instead? That is opt-in:  $bin service install"
  Write-Host "Uninstall any time:  $bin uninstall"

  $noRun = [Environment]::GetEnvironmentVariable('OPENGENI_NO_RUN')
  if ($noRun -ne '1' -and [Environment]::UserInteractive) {
    Write-Host ""
    Log "starting a foreground run (Ctrl-C to stop; set OPENGENI_NO_RUN=1 to skip)"
    & $bin run
  }
}

Main
