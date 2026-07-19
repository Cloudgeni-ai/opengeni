# Prove the headless enrollment grant stays in the child environment and never
# appears in the Windows installer's child argv.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$agentDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installer = Join-Path $agentDir 'install\install.ps1'
$work = Join-Path $env:TEMP ("og-enroll-argv-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  $env:OPENGENI_INSTALL_LIB = '1'
  . $installer

  $fake = Join-Path $work 'fake-agent.cmd'
  @'
@echo off
echo %* > "%OPENGENI_TEST_ARGV_LOG%"
<nul set /p =%OPENGENI_ENROLL_TOKEN% > "%OPENGENI_TEST_TOKEN_LOG%"
'@ | Set-Content -Path $fake -Encoding ASCII

  $env:OPENGENI_ENROLL_TOKEN = 'oget_test-secret-never-in-argv'
  $env:OPENGENI_API_URL = 'https://api.example.test'
  $env:OPENGENI_TEST_ARGV_LOG = Join-Path $work 'argv.txt'
  $env:OPENGENI_TEST_TOKEN_LOG = Join-Path $work 'token.txt'
  Complete-Install $fake | Out-Null

  $argv = (Get-Content $env:OPENGENI_TEST_ARGV_LOG -Raw).Trim()
  if ($argv -ne '--api-url https://api.example.test enroll --non-interactive') {
    throw "headless enroll argv drifted: $argv"
  }
  if ($argv.Contains('--token') -or $argv.Contains($env:OPENGENI_ENROLL_TOKEN)) {
    throw 'headless enrollment grant leaked into child argv'
  }
  $inherited = Get-Content $env:OPENGENI_TEST_TOKEN_LOG -Raw
  if ($inherited -ne $env:OPENGENI_ENROLL_TOKEN) {
    throw 'fake child did not inherit OPENGENI_ENROLL_TOKEN'
  }
  Write-Host 'enroll-token-argv OK: Windows child uses environment, not argv'
} finally {
  Remove-Item Env:OPENGENI_INSTALL_LIB -ErrorAction SilentlyContinue
  Remove-Item Env:OPENGENI_ENROLL_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:OPENGENI_API_URL -ErrorAction SilentlyContinue
  Remove-Item Env:OPENGENI_TEST_ARGV_LOG -ErrorAction SilentlyContinue
  Remove-Item Env:OPENGENI_TEST_TOKEN_LOG -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}