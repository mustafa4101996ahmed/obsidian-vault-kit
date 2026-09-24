#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the Obsidian vault kit: the vault itself, the Claude Code skills,
    and the automation that keeps the vault fed.

.DESCRIPTION
    Safe to run more than once. Nothing is overwritten without a backup, and every
    step reports whether it changed anything or found it already done.

    What it touches:
      <VaultPath>                             the vault (created if absent)
      %USERPROFILE%\.obsidian-wiki\           runner, config, logs, pending markers
      %USERPROFILE%\.claude\skills\<name>     junctions to the skills in the vault
      %USERPROFILE%\.claude\settings.json     adds one Stop hook (backed up first)
      $PROFILE                                adds one marked block (backed up first)

.EXAMPLE
    .\install.ps1 -DryRun
    Show what would happen. Changes nothing.

.EXAMPLE
    .\install.ps1
    Install, leaving the daily schedule off.

.EXAMPLE
    .\install.ps1 -EnableSchedule -ScheduleTime 19:00
    Install and turn on the daily ingest at 7pm.
#>
[CmdletBinding()]
param(
    [string]$VaultPath = (Join-Path $env:USERPROFILE 'Documents\Obsidian Vault'),
    [string]$Model = 'sonnet',
    [switch]$EnableSchedule,
    [string]$ScheduleTime = '19:00',
    [switch]$SkipGit,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$KitRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Scaffold = Join-Path $KitRoot 'vault-scaffold'
$AutoDir  = Join-Path $KitRoot 'automation'
$WikiDir  = Join-Path $env:USERPROFILE '.obsidian-wiki'
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$SkillsLink = Join-Path $ClaudeHome 'skills'

$script:Changed = @()
$script:Skipped = @()
$script:Warned  = @()

function Step   { param([string]$m) Write-Host "`n>> $m" -ForegroundColor Cyan }
function Did    { param([string]$m) $script:Changed += $m; Write-Host "   + $m" -ForegroundColor Green }
function Already{ param([string]$m) $script:Skipped += $m; Write-Host "   = $m" -ForegroundColor DarkGray }
function Warn   { param([string]$m) $script:Warned  += $m; Write-Host "   ! $m" -ForegroundColor Yellow }
function Plan   { param([string]$m) Write-Host "   ~ would: $m" -ForegroundColor Magenta }

if ($DryRun) { Write-Host "DRY RUN: nothing will be written.`n" -ForegroundColor Magenta }

# ===========================================================================
Step 'Checking prerequisites'
# ===========================================================================

Write-Host ("   PowerShell {0}" -f $PSVersionTable.PSVersion)

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    Warn 'claude is not on PATH. Install Claude Code first: npm install -g @anthropic-ai/claude-code'
    Warn 'Install will continue; the automation cannot run until claude is available.'
    $claudeExe = 'claude'
} else {
    $claudeExe = $claudeCmd.Source
    Write-Host "   claude -> $claudeExe"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Warn 'git is not on PATH. The vault will not be version-controlled.'
    $SkipGit = $true
}

$ep = Get-ExecutionPolicy -Scope CurrentUser
if ($ep -in @('Restricted', 'AllSigned')) {
    Warn "ExecutionPolicy for CurrentUser is '$ep'. The scheduled task passes -ExecutionPolicy Bypass so it will still run,"
    Warn "but to call wiki-history yourself run:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
}

if (-not (Test-Path $Scaffold)) { throw "Scaffold missing at $Scaffold. Is this the kit root?" }

# ===========================================================================
Step "Creating the vault at $VaultPath"
# ===========================================================================

$vaultExisted = Test-Path $VaultPath

if ($vaultExisted) {
    $hasContent = @(Get-ChildItem -LiteralPath $VaultPath -Force -ErrorAction SilentlyContinue).Count -gt 0
    if ($hasContent) {
        Warn 'That folder already exists and is not empty.'
        Warn 'Existing files are never overwritten; only missing ones are added.'
    }
}

function Copy-IfAbsent {
    param([string]$Source, [string]$Destination)
    $srcRoot = (Resolve-Path $Source).Path
    foreach ($item in Get-ChildItem -LiteralPath $srcRoot -Recurse -Force) {
        $rel  = $item.FullName.Substring($srcRoot.Length).TrimStart('\', '/')
        $dest = Join-Path $Destination $rel
        if ($item.PSIsContainer) {
            if (-not (Test-Path $dest)) {
                if ($DryRun) { Plan "mkdir $rel" } else { New-Item -ItemType Directory -Force -Path $dest | Out-Null; Did "dir  $rel" }
            }
        } else {
            if (Test-Path $dest) {
                Already "file $rel (kept yours)"
            } elseif ($DryRun) {
                Plan "copy $rel"
            } else {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
                Copy-Item -LiteralPath $item.FullName -Destination $dest
                Did "file $rel"
            }
        }
    }
}

if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $VaultPath | Out-Null }
Copy-IfAbsent -Source $Scaffold -Destination $VaultPath

# The scaffold ships its .gitignore as _gitignore: a real one would apply to the
# kit's own repo and stop _raw/ shipping at all. Put it in place under its real name.
$ignoreTemplate = Join-Path $VaultPath '_gitignore'
$ignoreTarget   = Join-Path $VaultPath '.gitignore'
if ($DryRun) {
    Plan 'install _gitignore as .gitignore'
} elseif (Test-Path $ignoreTemplate) {
    if (Test-Path $ignoreTarget) {
        Already '.gitignore (kept yours)'
    } else {
        Copy-Item -LiteralPath $ignoreTemplate -Destination $ignoreTarget
        Did '.gitignore installed'
    }
    Remove-Item $ignoreTemplate -Force
}

# stamp the real vault path into the fresh manifest
$manifest = Join-Path $VaultPath '.manifest.json'
if (-not $DryRun -and (Test-Path $manifest)) {
    $raw = Get-Content -LiteralPath $manifest -Raw
    if ($raw -match 'REPLACE_VAULT') {
        $raw = $raw.Replace('REPLACE_VAULT', ($VaultPath -replace '\\','\\'))
        Set-Content -LiteralPath $manifest -Value $raw -Encoding UTF8
        Did 'stamped vault path into .manifest.json'
    } else {
        Already '.manifest.json already stamped'
    }
}

# ===========================================================================
Step 'Installing the automation'
# ===========================================================================

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Join-Path $WikiDir 'logs') | Out-Null
    foreach ($f in @('run-ingest.ps1', 'mark-pending.ps1')) {
        Copy-Item -LiteralPath (Join-Path $AutoDir $f) -Destination (Join-Path $WikiDir $f) -Force
        Did "$f -> .obsidian-wiki\"
    }
    Copy-Item -LiteralPath (Join-Path $AutoDir 'schedule\Register-IngestTask.ps1') `
              -Destination (Join-Path $WikiDir 'Register-IngestTask.ps1') -Force
    Did 'Register-IngestTask.ps1 -> .obsidian-wiki\'

    [ordered]@{
        vaultPath = $VaultPath
        claudeExe = $claudeExe
        model     = $Model
        installed = (Get-Date -Format 'o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WikiDir 'config.json') -Encoding UTF8
    Did 'config.json written'
} else {
    Plan "copy run-ingest.ps1, mark-pending.ps1, Register-IngestTask.ps1 to $WikiDir"
    Plan 'write config.json'
}

# ===========================================================================
Step 'Linking skills into Claude Code'
# ===========================================================================
# Junctions, not symlinks: a directory junction needs no administrator rights
# and no Developer Mode. The vault stays the single source of truth.

if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $SkillsLink | Out-Null }

$skillSrcRoot = Join-Path $VaultPath '.agents\skills'
$skillNames = if (Test-Path $skillSrcRoot) {
    @(Get-ChildItem -LiteralPath $skillSrcRoot -Directory | Select-Object -ExpandProperty Name)
} else {
    @(Get-ChildItem -LiteralPath (Join-Path $Scaffold '.agents\skills') -Directory | Select-Object -ExpandProperty Name)
}

foreach ($name in $skillNames) {
    $link   = Join-Path $SkillsLink $name
    $target = Join-Path $skillSrcRoot $name

    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
            Already "skill $name (already linked)"
        } else {
            Warn "skill $name exists as a real folder, not a link; left alone. Remove it and re-run to link."
        }
        continue
    }
    if ($DryRun) { Plan "junction skills\$name -> $target"; continue }
    try {
        New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null
        Did "skill $name linked"
    } catch {
        Copy-Item -LiteralPath $target -Destination $link -Recurse -Force
        Warn "skill $name copied instead of linked (junction failed: $($_.Exception.Message))"
    }
}

# ===========================================================================
Step 'Registering the Claude Code Stop hook'
# ===========================================================================
# Fires once per ended turn and records that an ingest has work to do.

$settingsPath = Join-Path $ClaudeHome 'settings.json'
$hookCommand  = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $WikiDir 'mark-pending.ps1')

if ($DryRun) {
    Plan "add Stop hook to $settingsPath"
} else {
    $settings = if (Test-Path $settingsPath) {
        Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    } else {
        New-Item -ItemType Directory -Force -Path $ClaudeHome | Out-Null
        [pscustomobject]@{}
    }

    # Work in a hashtable so new keys can be added regardless of the original shape.
    $asHash = @{}
    foreach ($p in $settings.PSObject.Properties) { $asHash[$p.Name] = $p.Value }

    $hooks = @{}
    if ($asHash.ContainsKey('hooks') -and $asHash['hooks']) {
        foreach ($p in $asHash['hooks'].PSObject.Properties) { $hooks[$p.Name] = $p.Value }
    }

    $stopList = @()
    if ($hooks.ContainsKey('Stop') -and $hooks['Stop']) { $stopList = @($hooks['Stop']) }

    $already = $false
    foreach ($entry in $stopList) {
        foreach ($h in @($entry.hooks)) {
            if ($h -and $h.command -and $h.command -like '*mark-pending.ps1*') { $already = $true }
        }
    }

    if ($already) {
        Already 'Stop hook (already present)'
    } else {
        $stopList += [pscustomobject]@{
            matcher = ''
            hooks   = @([pscustomobject]@{ type = 'command'; command = $hookCommand; timeout = 5 })
        }
        $hooks['Stop'] = $stopList
        $asHash['hooks'] = [pscustomobject]$hooks
        ([pscustomobject]$asHash) | ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath $settingsPath -Encoding UTF8
        Did "Stop hook added (previous settings.json backed up)"
    }
}

# ===========================================================================
Step 'Adding the shell block to your PowerShell profile'
# ===========================================================================

$marker = '# ===== obsidian-wiki ='
$blockText = Get-Content -LiteralPath (Join-Path $AutoDir 'profile-block.ps1') -Raw

if ($DryRun) {
    Plan "append the obsidian-wiki block to $PROFILE"
} else {
    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PROFILE) | Out-Null
        New-Item -ItemType File -Force -Path $PROFILE | Out-Null
        Did 'created a PowerShell profile'
    }
    $existing = Get-Content -LiteralPath $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($existing -and $existing.Contains($marker)) {
        Already 'profile block (already present)'
    } else {
        Copy-Item -LiteralPath $PROFILE -Destination "$PROFILE.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -ErrorAction SilentlyContinue
        Add-Content -LiteralPath $PROFILE -Value "`n$blockText"
        Did 'profile block added (wiki-history, wiki-log, pending greeting)'
    }
}

# ===========================================================================
Step 'Version-controlling the vault'
# ===========================================================================

if ($SkipGit) {
    Already 'git skipped'
} elseif ($DryRun) {
    Plan "git init in $VaultPath"
} elseif (Test-Path (Join-Path $VaultPath '.git')) {
    Already 'vault is already a git repo'
} else {
    Push-Location -LiteralPath $VaultPath
    try {
        git init --quiet
        git add -A
        $who = (git config user.email) 2>$null
        if ([string]::IsNullOrWhiteSpace($who)) {
            Did 'git repo initialised (files staged, not committed)'
            Warn 'No git identity configured, so nothing was committed. Set one and commit:'
            Warn '  git config --global user.name "Your Name"'
            Warn '  git config --global user.email "you@example.com"'
            Warn ('  cd "{0}"; git commit -m "Initial vault"' -f $VaultPath)
        } else {
            git commit --quiet -m 'Initial vault scaffold from obsidian-vault-kit'
            Did 'git repo initialised with an initial commit'
        }
    } catch {
        Warn "git init did not complete: $($_.Exception.Message)"
    } finally {
        Pop-Location
    }
}

# ===========================================================================
Step 'Daily schedule'
# ===========================================================================

if (-not $EnableSchedule) {
    Already "schedule not enabled (turn it on later: .\install.ps1 -EnableSchedule)"
} elseif ($DryRun) {
    Plan "register scheduled task ObsidianWikiDailyIngest at $ScheduleTime"
} else {
    try {
        & (Join-Path $WikiDir 'Register-IngestTask.ps1') -Time $ScheduleTime
        Did "daily ingest scheduled at $ScheduleTime"
    } catch {
        Warn "could not register the scheduled task: $($_.Exception.Message)"
    }
}

# ===========================================================================
# Summary
# ===========================================================================

Write-Host "`n------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ("{0}: {1} change(s), {2} already in place, {3} warning(s)" -f `
    $(if ($DryRun) { 'Dry run' } else { 'Done' }), $script:Changed.Count, $script:Skipped.Count, $script:Warned.Count)

if ($script:Warned.Count) {
    Write-Host "`nWarnings to deal with:" -ForegroundColor Yellow
    $script:Warned | ForEach-Object { Write-Host "  ! $_" -ForegroundColor Yellow }
}

if (-not $DryRun) {
    Write-Host @"

Next, in order:

  1. Open a NEW PowerShell window          (loads wiki-history and the greeting)
  2. Open the vault in Obsidian            Open folder as vault ->
                                           $VaultPath
  3. Install the two community plugins      Settings > Community plugins > Browse:
                                           nexus-ai-chat-importer, infranodus-graph-view
  4. Drop a document in and ingest it:
         cd "$VaultPath"
         claude
         > /obsidian-wiki-ingest  (then point it at your file)

  5. When you have some Claude history, try the full run:
         wiki-history -Force

Full walkthrough: SETUP-GUIDE.md in this kit.
"@ -ForegroundColor Gray
}
