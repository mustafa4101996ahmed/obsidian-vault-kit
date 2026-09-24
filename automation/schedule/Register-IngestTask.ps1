#Requires -Version 5.1
<#
    Registers the daily ingest as a Windows scheduled task.

    Runs as the logged-in user, on-demand-friendly, and catches up if the machine
    was asleep at the scheduled time (StartWhenAvailable) — an ingest missed is an
    ingest never done otherwise.

    Needs no administrator rights: the task is registered in the current user's
    context and runs only when that user is logged on.
#>
[CmdletBinding()]
param(
    [string]$Time = '19:00',
    [string]$TaskName = 'ObsidianWikiDailyIngest',
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runner = Join-Path $env:USERPROFILE '.obsidian-wiki\run-ingest.ps1'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Unregistered '$TaskName'."
    return
}

if (-not (Test-Path $runner)) { throw "Runner not found at $runner. Run install.ps1 first." }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $runner)

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Ingest Claude Code history into the Obsidian vault' `
    -Force | Out-Null

Write-Host "Registered '$TaskName' — daily at $Time."
Write-Host "Check it:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Run now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove:    .\Register-IngestTask.ps1 -Unregister"
