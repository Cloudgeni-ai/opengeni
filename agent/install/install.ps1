<#
.SYNOPSIS
  Opengeni self-hosted agent installer — Windows (PowerShell 5.1+ / 7+).

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
  OPENGENI_INSTALL_DIR       Install dir (default %LOCALAPPDATA%\Opengeni\bin).
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
# A served installer rewrites this stable marker to the deployment that served
# it. Keep the caller override process-local and avoid mutating the parent shell.
$OpengeniApiDefaultUrl = 'https://app.opengeni.ai'
$script:ApiUrl = Get-EnvOr 'OPENGENI_API_URL' $OpengeniApiDefaultUrl
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

function Test-ReleaseAssetAvailable($name, $tmp) {
  # Windows PowerShell 5.1 redraws its progress bar for every chunk, which
  # slows downloads to a crawl. Local to this function, so a shell that runs
  # the script through `iex` keeps its own preference.
  $ProgressPreference = 'SilentlyContinue'
  $url = "$(Get-AssetUrl $name).sha256"
  try {
    if ($url -like 'file://*') {
      return Test-Path -LiteralPath ([uri]$url).LocalPath -PathType Leaf
    }
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-Download($url, $out) {
  # See Test-ReleaseAssetAvailable: without this a ~100 MB agent takes minutes.
  $ProgressPreference = 'SilentlyContinue'
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

# A self-contained minisign verifier, so a stock Windows machine (no minisign,
# no OpenSSL) can verify the agent. Neither .NET Framework nor modern .NET ships
# Ed25519 or BLAKE2b, so both are implemented here from RFC 8032 and RFC 7693 and
# compiled at run time. It checks the key id, the file signature (prehashed "ED"
# or legacy "Ed") and the trusted-comment signature, exactly like `minisign -V`.
$OpengeniMinisignVerifierSource = @'
using System;
using System.IO;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace OpengeniInstall {
  public static class Minisign {
    static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    static readonly BigInteger D = Mod(-121665 * Inv(121666));
    static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
    static readonly BigInteger[] Base = BasePoint();

    static BigInteger Mod(BigInteger x) { BigInteger r = x % P; return r.Sign < 0 ? r + P : r; }
    static BigInteger Inv(BigInteger x) { return BigInteger.ModPow(Mod(x), P - 2, P); }

    static BigInteger[] BasePoint() {
      BigInteger y = Mod(4 * Inv(5));
      BigInteger x;
      RecoverX(y, 0, out x);
      return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
    }

    static bool RecoverX(BigInteger y, int sign, out BigInteger x) {
      x = BigInteger.Zero;
      if (y >= P) return false;
      BigInteger x2 = Mod((y * y - 1) * Inv(D * y * y + 1));
      if (x2.IsZero) return sign == 0;
      x = BigInteger.ModPow(x2, (P + 3) / 8, P);
      if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtM1);
      if (!Mod(x * x - x2).IsZero) return false;
      if ((int)(x & 1) != sign) x = P - x;
      return true;
    }

    static BigInteger Le(byte[] bytes, int offset, int count) {
      byte[] le = new byte[count + 1];
      Array.Copy(bytes, offset, le, 0, count);
      return new BigInteger(le);
    }

    static BigInteger[] Decode(byte[] bytes, int offset) {
      byte[] copy = new byte[32];
      Array.Copy(bytes, offset, copy, 0, 32);
      int sign = copy[31] >> 7;
      copy[31] &= 0x7f;
      BigInteger y = Le(copy, 0, 32);
      BigInteger x;
      if (!RecoverX(y, sign, out x)) return null;
      return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
    }

    static BigInteger[] Add(BigInteger[] p, BigInteger[] q) {
      BigInteger a = Mod((p[1] - p[0]) * (q[1] - q[0]));
      BigInteger b = Mod((p[1] + p[0]) * (q[1] + q[0]));
      BigInteger c = Mod(p[3] * 2 * D * q[3]);
      BigInteger d = Mod(p[2] * 2 * q[2]);
      BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
      return new BigInteger[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
    }

    static BigInteger[] Multiply(BigInteger s, BigInteger[] p) {
      BigInteger[] q = new BigInteger[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
      while (s.Sign > 0) {
        if (!s.IsEven) q = Add(q, p);
        p = Add(p, p);
        s >>= 1;
      }
      return q;
    }

    static bool SamePoint(BigInteger[] p, BigInteger[] q) {
      return Mod(p[0] * q[2] - q[0] * p[2]).IsZero && Mod(p[1] * q[2] - q[1] * p[2]).IsZero;
    }

    /// RFC 8032 Ed25519 verification of a 64-byte signature by a 32-byte key.
    public static bool VerifyEd25519(byte[] key, byte[] message, byte[] signature) {
      if (key.Length != 32 || signature.Length != 64) return false;
      BigInteger[] a = Decode(key, 0);
      BigInteger[] r = Decode(signature, 0);
      if (a == null || r == null) return false;
      BigInteger s = Le(signature, 32, 32);
      if (s >= L) return false;
      byte[] digest;
      using (SHA512 sha = SHA512.Create()) {
        sha.TransformBlock(signature, 0, 32, null, 0);
        sha.TransformBlock(key, 0, 32, null, 0);
        sha.TransformFinalBlock(message, 0, message.Length);
        digest = sha.Hash;
      }
      BigInteger k = Le(digest, 0, 64) % L;
      return SamePoint(Multiply(s, Base), Add(r, Multiply(k, a)));
    }

    static readonly ulong[] Iv = {
      0x6a09e667f3bcc908UL, 0xbb67ae8584caa73bUL, 0x3c6ef372fe94f82bUL, 0xa54ff53a5f1d36f1UL,
      0x510e527fade682d1UL, 0x9b05688c2b3e6c1fUL, 0x1f83d9abfb41bd6bUL, 0x5be0cd19137e2179UL };
    static readonly byte[,] Sigma = {
      { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
      { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 },
      { 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4 },
      { 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8 },
      { 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13 },
      { 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9 },
      { 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11 },
      { 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10 },
      { 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5 },
      { 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0 } };

    static ulong Rotr(ulong x, int n) { return (x >> n) | (x << (64 - n)); }

    static void Compress(ulong[] h, byte[] block, ulong t0, ulong t1, bool last) {
      ulong[] v = new ulong[16];
      ulong[] m = new ulong[16];
      for (int i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = Iv[i]; }
      v[12] ^= t0;
      v[13] ^= t1;
      if (last) v[14] = ~v[14];
      for (int i = 0; i < 16; i++) m[i] = BitConverter.ToUInt64(block, i * 8);
      for (int round = 0; round < 12; round++) {
        int s = round % 10;
        Mix(v, 0, 4, 8, 12, m[Sigma[s, 0]], m[Sigma[s, 1]]);
        Mix(v, 1, 5, 9, 13, m[Sigma[s, 2]], m[Sigma[s, 3]]);
        Mix(v, 2, 6, 10, 14, m[Sigma[s, 4]], m[Sigma[s, 5]]);
        Mix(v, 3, 7, 11, 15, m[Sigma[s, 6]], m[Sigma[s, 7]]);
        Mix(v, 0, 5, 10, 15, m[Sigma[s, 8]], m[Sigma[s, 9]]);
        Mix(v, 1, 6, 11, 12, m[Sigma[s, 10]], m[Sigma[s, 11]]);
        Mix(v, 2, 7, 8, 13, m[Sigma[s, 12]], m[Sigma[s, 13]]);
        Mix(v, 3, 4, 9, 14, m[Sigma[s, 14]], m[Sigma[s, 15]]);
      }
      for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
    }

    static void Mix(ulong[] v, int a, int b, int c, int d, ulong x, ulong y) {
      v[a] = v[a] + v[b] + x; v[d] = Rotr(v[d] ^ v[a], 32);
      v[c] = v[c] + v[d]; v[b] = Rotr(v[b] ^ v[c], 24);
      v[a] = v[a] + v[b] + y; v[d] = Rotr(v[d] ^ v[a], 16);
      v[c] = v[c] + v[d]; v[b] = Rotr(v[b] ^ v[c], 63);
    }

    /// RFC 7693 BLAKE2b with a 64-byte digest and no key, over a whole stream.
    public static byte[] Blake2b512(Stream input) {
      ulong[] h = (ulong[])Iv.Clone();
      h[0] ^= 0x01010040UL;
      byte[] block = new byte[128];
      int filled = 0;
      ulong t0 = 0, t1 = 0;
      byte[] chunk = new byte[1 << 16];
      int read;
      while ((read = input.Read(chunk, 0, chunk.Length)) > 0) {
        int offset = 0;
        while (offset < read) {
          if (filled == 128) {
            t0 += 128; if (t0 < 128) t1++;
            Compress(h, block, t0, t1, false);
            filled = 0;
          }
          int take = Math.Min(128 - filled, read - offset);
          Array.Copy(chunk, offset, block, filled, take);
          filled += take;
          offset += take;
        }
      }
      t0 += (ulong)filled; if (t0 < (ulong)filled) t1++;
      Array.Clear(block, filled, 128 - filled);
      Compress(h, block, t0, t1, true);
      byte[] digest = new byte[64];
      for (int i = 0; i < 8; i++) Array.Copy(BitConverter.GetBytes(h[i]), 0, digest, i * 8, 8);
      return digest;
    }

    /// Returns null when the file verifies, otherwise the reason it does not.
    public static string Verify(string file, string signatureFile, string publicKey) {
      if (!BitConverter.IsLittleEndian) return "unsupported byte order";
      byte[] pk = Convert.FromBase64String(publicKey.Trim());
      if (pk.Length != 42 || pk[0] != (byte)'E' || pk[1] != (byte)'d') return "the pinned public key is malformed";
      string[] lines = File.ReadAllLines(signatureFile);
      if (lines.Length < 4) return "the signature file is incomplete";
      byte[] sig = Convert.FromBase64String(lines[1].Trim());
      if (sig.Length != 74) return "the signature is malformed";
      for (int i = 2; i < 10; i++) if (sig[i] != pk[i]) return "the signature was made with a different key";
      byte[] key = new byte[32];
      Array.Copy(pk, 10, key, 0, 32);
      byte[] signature = new byte[64];
      Array.Copy(sig, 10, signature, 0, 64);
      byte[] message;
      if (sig[0] == (byte)'E' && sig[1] == (byte)'D') {
        using (FileStream stream = File.OpenRead(file)) message = Blake2b512(stream);
      } else if (sig[0] == (byte)'E' && sig[1] == (byte)'d') {
        message = File.ReadAllBytes(file);
      } else {
        return "the signature algorithm is not supported";
      }
      if (!VerifyEd25519(key, message, signature)) return "the signature does not match";
      const string prefix = "trusted comment: ";
      if (!lines[2].StartsWith(prefix, StringComparison.Ordinal)) return "the trusted comment is missing";
      byte[] comment = Encoding.UTF8.GetBytes(lines[2].Substring(prefix.Length));
      byte[] globalSignature = Convert.FromBase64String(lines[3].Trim());
      byte[] signedComment = new byte[64 + comment.Length];
      Array.Copy(signature, 0, signedComment, 0, 64);
      Array.Copy(comment, 0, signedComment, 64, comment.Length);
      if (!VerifyEd25519(key, signedComment, globalSignature)) return "the trusted comment signature does not match";
      return null;
    }
  }
}
'@

# Compiles the verifier once per session; $false where compiling is not
# allowed (for example PowerShell's constrained language mode).
function Initialize-MinisignVerifier {
  if ('OpengeniInstall.Minisign' -as [type]) { return $true }
  foreach ($references in @(@('System.Numerics'), @())) {
    try {
      if ($references.Count -gt 0) {
        Add-Type -TypeDefinition $OpengeniMinisignVerifierSource -ReferencedAssemblies $references -ErrorAction Stop
      } else {
        Add-Type -TypeDefinition $OpengeniMinisignVerifierSource -ErrorAction Stop
      }
      return $true
    } catch { }
  }
  return $false
}

# Verify the minisign signature against the pinned key, failing closed. The
# built-in verifier needs nothing installed; minisign.exe or OpenSSL are used
# only where PowerShell cannot compile it.
function Test-Signature($file, $sig) {
  if (Initialize-MinisignVerifier) {
    $problem = [OpengeniInstall.Minisign]::Verify($file, $sig, $OPENGENI_MINISIGN_PUBKEY)
    if ($null -ne $problem) { Fail 5 "minisign signature verification FAILED for $(Split-Path $file -Leaf): $problem" }
    Log "minisign signature verified"
    return
  }
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

function Install-VerifiedInteractionRuntime($agentAsset, $tmp, $installDir) {
  $target = $agentAsset -replace '^opengeni-agent-', '' -replace '\.exe$', ''
  $browserd = "opengeni-browserd-$target.exe"
  $agentBrowser = "opengeni-agent-browser-$target.exe"
  $computerNative = "opengeni-computer-native-$target.exe"
  $probe = Join-Path $tmp 'interaction-runtime-probe.sha256'
  if (-not (Test-ReleaseAssetAvailable $browserd $probe)) {
    Log 'this release predates the packaged browser/computer runtime'
    return
  }

  $runtime = @(
    @{ Asset = $browserd; Destination = 'opengeni-browserd.exe' },
    @{ Asset = $agentBrowser; Destination = 'agent-browser.exe' },
    @{ Asset = $computerNative; Destination = 'opengeni-computer-native.exe' }
  )
  $staged = Join-Path $tmp 'interaction-runtime'
  New-Item -ItemType Directory -Path $staged -Force | Out-Null
  foreach ($entry in $runtime) {
    $assetName = [string]$entry.Asset
    $assetUrl = Get-AssetUrl $assetName
    $assetPath = Join-Path $staged ([string]$entry.Destination)
    $shaPath = "$assetPath.sha256"
    $sigPath = "$assetPath.minisig"
    Invoke-Download $assetUrl $assetPath
    Invoke-Download "$assetUrl.sha256" $shaPath
    Invoke-Download "$assetUrl.minisig" $sigPath
    $want = ((Get-Content $shaPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $got = Get-Sha256 $assetPath
    if ($want -ne $got) { Fail 4 "checksum mismatch for ${assetName}: expected $want got $got" }
    Test-Signature $assetPath $sigPath
  }

  foreach ($entry in $runtime) {
    $destination = Join-Path $installDir ([string]$entry.Destination)
    $incoming = "$destination.new"
    Copy-Item -LiteralPath (Join-Path $staged ([string]$entry.Destination)) -Destination $incoming -Force
    Move-Item -LiteralPath $incoming -Destination $destination -Force
  }
  Log "installed the version-coherent browser/computer runtime in $installDir"
}

function Get-InstallDir {
  $d = Get-EnvOr 'OPENGENI_INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'Opengeni\bin')
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
      Install-VerifiedInteractionRuntime $asset $tmp $installDir
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
    # Opengeni connections remain configured and online.
    & $bin --api-url $script:ApiUrl connect --token $enrollToken --non-interactive
    if ($LASTEXITCODE -ne 0) { Fail 7 "machine connection failed; background service was not changed" }
    Start-BackgroundAgent $bin
    return
  }

  $workspaceId = [Environment]::GetEnvironmentVariable('OPENGENI_WORKSPACE_ID')
  if (-not [string]::IsNullOrEmpty($workspaceId)) {
    & $bin --api-url $script:ApiUrl connect --workspace-id $workspaceId
    if ($LASTEXITCODE -ne 0) { Fail 7 "machine connection failed; background service was not changed" }
    Start-BackgroundAgent $bin
    return
  }

  # The installer process's environment does not survive into the command the
  # operator pastes later. Preserve this served deployment explicitly, including
  # paths/origins containing PowerShell's single-quote character.
  $quotedBin = ([string]$bin).Replace("'", "''")
  $quotedApiUrl = ([string]$script:ApiUrl).Replace("'", "''")
  Write-Host "opengeni-agent installed at: $bin"
  Write-Host ""
  Write-Host "Next: & '$quotedBin' --api-url '$quotedApiUrl' connect; if (`$?) { & '$quotedBin' start }"
  Write-Host "Use '$bin run' only when you explicitly want foreground mode."
  Write-Host "Uninstall any time:  $bin uninstall"
}

Main
