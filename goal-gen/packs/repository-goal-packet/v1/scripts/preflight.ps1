#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Read-only sanity checks run before scripts/launch.ps1.

.DESCRIPTION
  Performs no writes to the packet or to the target repository.

.PARAMETER TargetRepo
  Path to the target repository worktree.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$TargetRepo
)

$PacketRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Failed = $false

function Test-Check {
  param([string]$Desc, [scriptblock]$Block)
  try {
    if (& $Block) {
      Write-Host "  [ok] $Desc"
      return $true
    }
  } catch {}
  Write-Host "  [FAIL] $Desc"
  $script:Failed = $true
  return $false
}

Write-Host "Preflight — $PacketRoot"
Write-Host ""

Write-Host "Tool availability:"
Test-Check "claude CLI present" { [bool](Get-Command claude -ErrorAction SilentlyContinue) } | Out-Null
Test-Check "git present" { [bool](Get-Command git -ErrorAction SilentlyContinue) } | Out-Null
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Write-Host "  [ok] gh CLI present (optional)"
} else {
  Write-Host "  [warn] gh CLI not found — GitHub-API-derived evidence in this packet cannot be revalidated live"
}

Write-Host ""
Write-Host "Packet integrity:"
$checksumFile = Join-Path $PacketRoot 'CHECKSUMS.sha256'
if (Test-Path $checksumFile) {
  $verifyFailed = $false
  foreach ($line in Get-Content $checksumFile) {
    if ($line -match '^(?<hash>[0-9a-fA-F]{64})\s+\*?(?<path>.+)$') {
      $expected = $Matches['hash'].ToLowerInvariant()
      $relPath = $Matches['path']
      $full = Join-Path $PacketRoot $relPath
      if (-not (Test-Path $full)) { $verifyFailed = $true; continue }
      $actual = (Get-FileHash -Algorithm SHA256 -Path $full).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { $verifyFailed = $true }
    }
  }
  if ($verifyFailed) {
    Write-Host "  [FAIL] CHECKSUMS.sha256 does NOT verify — packet may be tampered or incomplete"
    $Failed = $true
  } else {
    Write-Host "  [ok] CHECKSUMS.sha256 verifies"
  }
} else {
  Write-Host "  [FAIL] CHECKSUMS.sha256 missing at packet root"
  $Failed = $true
}
if (Test-Path (Join-Path $PacketRoot 'MANIFEST.json')) {
  Write-Host "  [ok] MANIFEST.json present"
} else {
  Write-Host "  [FAIL] MANIFEST.json missing at packet root"
  $Failed = $true
}

Write-Host ""
Write-Host "Target repository:"
if (Test-Path $TargetRepo) {
  Write-Host "  [ok] target path exists"
  Push-Location $TargetRepo
  try {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  [ok] target is a git working tree"
      $currentSha = (git rev-parse HEAD).Trim()
      Write-Host "  [info] current HEAD: $currentSha"
      Write-Host "  [info] compare this against contracts/request.json / evidence/repository-profile.json;"
      Write-Host "  [info] a mismatch means the packet is stale and inspection should be rerun."
    } else {
      Write-Host "  [FAIL] target is not a git working tree"
      $Failed = $true
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "  [FAIL] target path does not exist: $TargetRepo"
  $Failed = $true
}

Write-Host ""
if (-not $Failed) {
  Write-Host "Preflight PASSED. This check performed no writes to the packet or the target repository."
  exit 0
} else {
  Write-Host "Preflight FAILED. Resolve the items above before running scripts/launch.ps1."
  exit 1
}
