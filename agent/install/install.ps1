<#
.SYNOPSIS
  OpenGeni self-hosted agent installer — Windows (PowerShell 5.1+ / 7+).

.DESCRIPTION
  irm https://get.opengeni.ai/install.ps1 | iex

  READ THIS BEFORE PIPING IT TO iex. This script downloads the opengeni-agent.exe
  for your arch, VERIFIES it two independent ways (a minisign signature against a
  public key PINNED in this script's body, AND a sha256 checksum), installs it to
  a per-user path, adds that path to your user PATH, and then PRINTS the exact
  command to connect and keeps the machine online in the background when the
  service backend is available. It contains NO secrets. The pinned public key travels WITH this audited script, so
  a compromised CDN cannot serve a binary that verifies.

  Run model: the normal install is an always-on background agent; `run` remains
  the explicit foreground mode. This script is rename-running-exe
  aware: a re-install over a running agent renames the live .exe aside before
  placing the new one (the same trick self-update uses).

.PARAMETER -* (environment overrides, all optional)
  OPENGENI_INSTALL_BASE_URL  Release asset base URL (default https://get.opengeni.ai).
                             Point at a local mock (http://localhost/...) to test offline.
  OPENGENI_AGENT_VERSION     Pin a version (default "latest").
  OPENGENI_ALLOW_DOWNGRADE   "1" explicitly allows an older verified agent to
                             replace a newer installed one. Default: preserve newer.
  OPENGENI_INSTALL_DIR       Install dir (default %LOCALAPPDATA%\OpenGeni\bin).
  OPENGENI_ENROLL_TOKEN      Non-interactive connection token (CI/automation);
                             adds or refreshes only its deployment/workspace.
  OPENGENI_NO_SERVICE        "1" => save the connection without installing a service.
  OPENGENI_API_URL           Control-plane API base URL for the connection.

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
$OPENGENI_MINISIGN_PUBKEY = 'RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn'

function Get-EnvOr($name, $default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($v)) { return $default } else { return $v }
}

# A DEPLOYED control plane rewrites the next line to its own origin at serve time
# (see apps/api/src/routes/install.ts DEFAULT_BASE_REWRITES), so this Windows
# installer pulls the matching baked agent from the same host it was fetched from.
# Keep the line's shape stable (rewritten by exact match). OPENGENI_INSTALL_BASE_URL
# still wins.
$OpengeniInstallDefaultBaseUrl = 'https://get.opengeni.ai'
$BaseUrl = Get-EnvOr 'OPENGENI_INSTALL_BASE_URL' $OpengeniInstallDefaultBaseUrl
$Version = Get-EnvOr 'OPENGENI_AGENT_VERSION' 'latest'
$script:AgentWasUpgraded = $false

function Log($msg)  { Write-Host "opengeni-install: $msg" }
function Fail($code, $msg) { Write-Host "opengeni-install: ERROR: $msg" -ForegroundColor Red; exit $code }

function Get-AgentReleaseVersion($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $line = @(& $path --version 2>$null)[0]
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($line)) { return $null }
    $match = [regex]::Match([string]$line, '^opengeni-agent ([0-9]+\.[0-9]+\.[0-9]+)$')
    if (-not $match.Success) { return $null }
    return [version]$match.Groups[1].Value
  } catch {
    return $null
  }
}

function Test-KeepNewerAgent($installed, $candidate) {
  if ((Get-EnvOr 'OPENGENI_ALLOW_DOWNGRADE' '0') -eq '1') { return $false }
  $installedVersion = Get-AgentReleaseVersion $installed
  $candidateVersion = Get-AgentReleaseVersion $candidate
  if ($null -eq $installedVersion -or $null -eq $candidateVersion) { return $false }
  if ($installedVersion -gt $candidateVersion) {
    Log "keeping installed opengeni-agent $installedVersion; verified candidate $candidateVersion is older (set OPENGENI_ALLOW_DOWNGRADE=1 to override)"
    return $true
  }
  return $false
}

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
  $base = $BaseUrl.TrimEnd('/')
  # A pinned GitHub Release URL is already the asset directory. Keep the normal
  # edge layout everywhere else without duplicating it on the documented
  # direct-release fallback.
  if ($Version -ne 'latest' -and $base.EndsWith("/releases/download/agent-v$Version")) {
    return "$base/$name"
  }
  if ($Version -eq 'latest') { return "$base/agent/latest/$name" }
  return "$base/agent/v$Version/$name"
}

function Invoke-Download($url, $out) {
  try {
    # Support file:// (used by the install smoke test + air-gapped mirrors); the
    # built-in Invoke-WebRequest rejects the file scheme, unlike curl on Unix.
    if ($url -like 'file://*') {
      $local = ([uri]$url).LocalPath
      if (-not (Test-Path -LiteralPath $local)) { Fail 3 "file not found: $local" }
      Copy-Item -LiteralPath $local -Destination $out -Force
    } else {
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    }
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
    if (Test-KeepNewerAgent $dest $binTmp) {
      Remove-Item -Force $binTmp -ErrorAction SilentlyContinue
    } else {
      $oldVersion = Get-AgentReleaseVersion $dest
      $newVersion = Get-AgentReleaseVersion $binTmp
      if ($null -ne $oldVersion -and $null -ne $newVersion -and $oldVersion -ne $newVersion) {
        $script:AgentWasUpgraded = $true
      }
      if (Test-Path $dest) {
        $aside = "$dest.old"
        Remove-Item -Force $aside -ErrorAction SilentlyContinue
        try { Move-Item -Force $dest $aside } catch { } # locked-running: rename aside
      }
      Move-Item -Force $binTmp $dest
      Log "installed verified binary to $dest"
    }
    Add-UserPath $installDir

    Complete-Install $dest
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Start-BackgroundAgent($bin) {
  if ((Get-EnvOr 'OPENGENI_NO_SERVICE' '0') -eq '1') {
    Log "background service skipped (OPENGENI_NO_SERVICE=1); start with: $bin run"
    return
  }
  $startArgs = @('start')
  if ($script:AgentWasUpgraded) { $startArgs += '--restart' }
  try {
    & $bin @startArgs
    if ($LASTEXITCODE -eq 0) {
      Log "connected and running in the background"
      return
    }
  } catch { }
  Log "could not install a background service on this host; connection is saved"
  Log "start the foreground agent with: $bin run"
}

function Complete-Install($bin) {
  Write-Host ""
  $enrollToken = [Environment]::GetEnvironmentVariable('OPENGENI_ENROLL_TOKEN')
  if (-not [string]::IsNullOrEmpty($enrollToken)) {
    Log "non-interactive connection (OPENGENI_ENROLL_TOKEN set)"
    # This upserts only the token's deployment/workspace connection; unrelated
    # OpenGeni connections remain configured and online.
    $apiUrl = [Environment]::GetEnvironmentVariable('OPENGENI_API_URL')
    if ([string]::IsNullOrEmpty($apiUrl)) {
      & $bin connect --token $enrollToken --non-interactive
    } else {
      & $bin --api-url $apiUrl connect --token $enrollToken --non-interactive
    }
    if ($LASTEXITCODE -ne 0) { Fail 7 "machine connection failed; background service was not changed" }
    Start-BackgroundAgent $bin
    return
  }

  $workspaceId = [Environment]::GetEnvironmentVariable('OPENGENI_WORKSPACE_ID')
  if (-not [string]::IsNullOrEmpty($workspaceId)) {
    $apiUrl = [Environment]::GetEnvironmentVariable('OPENGENI_API_URL')
    if ([string]::IsNullOrEmpty($apiUrl)) {
      & $bin connect --workspace-id $workspaceId
    } else {
      & $bin --api-url $apiUrl connect --workspace-id $workspaceId
    }
    if ($LASTEXITCODE -ne 0) { Fail 7 "machine connection failed; background service was not changed" }
    Start-BackgroundAgent $bin
    return
  }

  Write-Host "opengeni-agent installed at: $bin"
  Write-Host ""
  Write-Host "Next: $bin connect; if (`$?) { $bin start }"
  Write-Host "Use '$bin run' only when you explicitly want foreground mode."
  Write-Host "Uninstall any time:  $bin uninstall"
}

Main
