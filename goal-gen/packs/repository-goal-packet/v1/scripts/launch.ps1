#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Launches Claude Code against the target repository using this packet.

.DESCRIPTION
  Requires prompts/MASTER_IMPLEMENTATION_PROMPT.md and CHECKSUMS.sha256 at the packet root.

  review    -> --permission-mode plan       (read-only review of the packet/plan)
  implement -> --permission-mode acceptEdits (approved implementation)

  This script never passes bypassPermissions as a --permission-mode value, and never falls back
  to it. Only an explicitly human-approved autonomous-isolated profile may ever consider that
  mode, and it is not implemented here. A worktree is writer-collision isolation, not a sandbox.
  Merge, deployment, and secret rotation remain unauthorized regardless of this run's outcome.

.PARAMETER TargetRepo
  Path to the target repository worktree.

.PARAMETER Mode
  'review' or 'implement'.

.PARAMETER AddDir
  Additional directories to pass through as --add-dir.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$TargetRepo,

  [ValidateSet('review', 'implement')]
  [string]$Mode = 'review',

  [string[]]$AddDir = @()
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "claude CLI not found"
  exit 1
}

$PacketRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetRepoAbs = (Resolve-Path $TargetRepo).Path
$MasterPrompt = Join-Path $PacketRoot 'prompts/MASTER_IMPLEMENTATION_PROMPT.md'
if (-not (Test-Path $MasterPrompt)) {
  Write-Error "missing prompts/MASTER_IMPLEMENTATION_PROMPT.md — refusing to launch without the packet goal"
  exit 1
}
$PromptText = Get-Content -Raw $MasterPrompt

Write-Host "Verifying packet integrity before launch..."
Push-Location $PacketRoot
try {
  $checksumFile = Join-Path $PacketRoot 'CHECKSUMS.sha256'
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
    Write-Error "Packet checksum verification FAILED — refusing to launch against a possibly-tampered or incomplete packet."
    exit 1
  }
} finally {
  Pop-Location
}

$PermissionMode = switch ($Mode) {
  'review'    { 'plan' }
  'implement' { 'acceptEdits' }
}

# Lead model resolution order: explicit env override, then the packet's own resolved
# orchestration contract (contracts/orchestration.json lead.modelId — the source of truth),
# then the claude-fable-opus-sonnet@1 profile's documented lead as a last-resort literal.
$LeadModel = $env:YELLOW_GOAL_LEAD_MODEL
if (-not $LeadModel) {
  $OrchContract = Join-Path $PacketRoot 'contracts/orchestration.json'
  if (Test-Path $OrchContract) {
    try { $LeadModel = (Get-Content $OrchContract -Raw | ConvertFrom-Json).lead.modelId } catch {}
  }
}
if (-not $LeadModel) { $LeadModel = 'claude-fable-5' }

# The packet directory usually lives outside the target repository's worktree (it is a sibling
# artifact, not part of the repository it describes). When that is the case, pass --add-dir so
# the session can still read the packet's prompts/contracts/evidence.
$AddDirArgs = @()
if (-not $TargetRepoAbs.StartsWith($PacketRoot)) {
  $AddDirArgs += @('--add-dir', $PacketRoot)
}
foreach ($d in $AddDir) {
  if ($d) { $AddDirArgs += @('--add-dir', (Resolve-Path $d).Path) }
}

Write-Host "Packet root: $PacketRoot"
Write-Host "Target repository: $TargetRepoAbs"
Write-Host "Mode: $Mode (--permission-mode $PermissionMode)"
Write-Host "Lead model: $LeadModel"
Write-Host ""
Write-Host "NOTE: a worktree is writer-collision isolation, not a security sandbox. An agent"
Write-Host "running here can still reach the host filesystem, credentials, network, and sibling"
Write-Host "repositories. Merge, deployment, and secret rotation remain unauthorized regardless"
Write-Host "of this run's outcome."

if (-not $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
  $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
}

Push-Location $TargetRepoAbs
try {
  & claude --model $LeadModel --effort high --permission-mode $PermissionMode --teammate-mode in-process @AddDirArgs $PromptText
  $ClaudeExit = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host "Re-verifying packet integrity after launch (immutability check)..."
Push-Location $PacketRoot
try {
  $checksumFile = Join-Path $PacketRoot 'CHECKSUMS.sha256'
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
    Write-Warning "Packet checksums changed during this run. The packet is meant to be immutable after sign-off; investigate before trusting this packet's contents further."
  }
} finally {
  Pop-Location
}

Write-Host "NOTE: if --teammate-mode in-process could not start an agent team, the session falls"
Write-Host "back to ordinary subagents. That fallback must be recorded in this run's evidence and"
Write-Host "must never be reported as an agent team."

exit $ClaudeExit
