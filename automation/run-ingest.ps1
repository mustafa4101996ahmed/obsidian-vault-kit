#Requires -Version 5.1
<#
    Claude-history -> wiki ingest.

    Runs unattended: once a day from the scheduled task, or on demand with -Force.

        run-ingest.ps1            ingest if any Claude turn has ended since the last run
        run-ingest.ps1 -Force     ingest regardless of the pending flag

    Log:    $env:USERPROFILE\.obsidian-wiki\logs\<date>.log
    Result: a desktop notification, if a notifier is available.

    Every guard in here exists because something went wrong without it. Read the comment
    before removing one.
#>
[CmdletBinding()]
param(
    [switch]$Force,
    # Minutes of transcript silence before the run is treated as hung rather than thinking.
    [int]$StallMinutes = 20,
    # Minutes after which a lock is assumed to belong to a crashed run.
    [int]$StaleLockMinutes = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths and configuration
# ---------------------------------------------------------------------------

$Dir = Join-Path $env:USERPROFILE '.obsidian-wiki'
$ConfigPath = Join-Path $Dir 'config.json'

if (-not (Test-Path $ConfigPath)) {
    # Write-Error is terminating under ErrorActionPreference='Stop', which buries this
    # behind a stack trace and skips the exit below. Print plainly and leave.
    [Console]::Error.WriteLine("No config at $ConfigPath.")
    [Console]::Error.WriteLine("Run install.ps1 from the vault kit first.")
    exit 1
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$Vault      = $cfg.vaultPath
$ClaudeExe  = $cfg.claudeExe
$Model      = if ($cfg.PSObject.Properties.Name -contains 'model' -and $cfg.model) { $cfg.model } else { 'sonnet' }
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$Projects   = Join-Path $ClaudeHome 'projects'

$Lock            = Join-Path $Dir '.lock'
$PendingFlag     = Join-Path $Dir '.pending_ingest'
$PendingSessions = Join-Path $Dir '.pending_sessions'
$RunStarted      = Join-Path $Dir '.run-started'

# ---------------------------------------------------------------------------
# Logging: every line this script emits lands in today's log, appended.
# ---------------------------------------------------------------------------

$LogDir = Join-Path $Dir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-RunLog {
    param([string]$Message)
    $line = $Message
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
    Write-Verbose $line
}

Write-RunLog ''
Write-RunLog ("=== {0} run-ingest{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($Force) { ' -Force' } else { '' }))

# ---------------------------------------------------------------------------
# Notification. Best available notifier; never fatal if none exists.
# ---------------------------------------------------------------------------

function Send-Notification {
    param([string]$Message)
    $title = 'Claude history -> wiki'
    try {
        if (Get-Module -ListAvailable -Name BurntToast -ErrorAction SilentlyContinue) {
            Import-Module BurntToast -ErrorAction Stop
            New-BurntToastNotification -Text $title, $Message -ErrorAction Stop
            return
        }
    } catch { }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $title
        $icon.BalloonTipText = $Message
        $icon.Visible = $true
        $icon.ShowBalloonTip(10000)
        Start-Sleep -Seconds 1
        $icon.Dispose()
    } catch {
        Write-RunLog "(no notifier available; message was: $Message)"
    }
}

function Stop-WithFailure {
    param([string]$Reason)
    Write-RunLog "FAILED: $Reason"
    Send-Notification "Failed: $Reason. Log: $Log"
    Remove-Lock
    exit 1
}

# ---------------------------------------------------------------------------
# One run at a time. Directory creation is the atomic test-and-set.
# A lock older than $StaleLockMinutes belongs to a run that crashed.
# ---------------------------------------------------------------------------

$script:HoldsLock = $false

function Remove-Lock {
    if ($script:HoldsLock -and (Test-Path $Lock)) {
        Remove-Item $Lock -Recurse -Force -ErrorAction SilentlyContinue
        $script:HoldsLock = $false
    }
}

function Get-Lock {
    try {
        New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
        $script:HoldsLock = $true
        return $true
    } catch {
        $age = (Get-Date) - (Get-Item $Lock).CreationTime
        if ($age.TotalMinutes -gt $StaleLockMinutes) {
            Write-RunLog ("clearing a stale lock ({0:N0} minutes old; a previous run crashed)" -f $age.TotalMinutes)
            Remove-Item $Lock -Recurse -Force
            New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
            $script:HoldsLock = $true
            return $true
        }
        Write-RunLog 'another run holds the lock; exiting'
        return $false
    }
}

if (-not (Get-Lock)) { exit 0 }

try {
    # -----------------------------------------------------------------------
    # Another writer on the vault means this run must wait its turn. Pending
    # work stays pending, so nothing is lost by exiting here.
    # -----------------------------------------------------------------------
    $otherLocks = @()
    if (Test-Path (Join-Path $Vault '_raw')) {
        $otherLocks = @(Get-ChildItem -LiteralPath (Join-Path $Vault '_raw') -Recurse -Directory `
                        -Filter '.lock' -ErrorAction SilentlyContinue)
    }
    if ($otherLocks.Count -gt 0) {
        Write-RunLog ("another vault writer holds {0}; exiting with work still pending" -f $otherLocks[0].FullName)
        exit 0
    }

    if (-not (Test-Path $PendingFlag) -and -not $Force) {
        Write-RunLog 'nothing pending'
        exit 0
    }

    # -----------------------------------------------------------------------
    # The Stop hook appends one line per ended turn. Record the count now, so
    # turns that end while this run works stay pending for the next one.
    # -----------------------------------------------------------------------
    if (-not (Test-Path $PendingSessions)) { New-Item -ItemType File -Path $PendingSessions | Out-Null }
    $mark = @(Get-Content -LiteralPath $PendingSessions -ErrorAction SilentlyContinue).Count
    Write-RunLog "pending turns at start: $mark"

    Set-Content -LiteralPath $RunStarted -Value (Get-Date -Format 'o') -Encoding UTF8
    $startStamp = (Get-Item $RunStarted).LastWriteTimeUtc

    # -----------------------------------------------------------------------
    # Launch Claude.
    #
    # The transcript directory is found by searching for the session id rather
    # than by rebuilding the project slug from the vault path: slug encoding is
    # lossy (spaces and hyphens collapse to the same character) and differs
    # between platforms. Searching cannot be wrong.
    # -----------------------------------------------------------------------
    $sid = [guid]::NewGuid().ToString().ToLower()

    $prompt = @'
Use the wiki-history-ingest skill with the argument claude, in append mode: ingest every Claude transcript and memory file that the manifest's per-file sources rows show as new or modified. Work unattended: do not ask questions; make the call and record it in the log.md entry, which goes directly under the '# Wiki Log' heading (newest first). If the delta is large, have read-only subagents digest groups of sessions while you stay the only writer to the vault. Every timestamp you write must come from a real clock reading in UTC, never an estimate.
'@

    $claudeArgs = @(
        '-p', $prompt,
        '--model', $Model,
        '--setting-sources', 'project,local',
        '--strict-mcp-config',
        '--permission-mode', 'acceptEdits',
        '--add-dir', $Projects,
        '--session-id', $sid,
        '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'TodoWrite',
            'Bash(python:*)', 'Bash(python3:*)', 'Bash(powershell:*)', 'Bash(ls:*)',
            'Bash(date:*)', 'Bash(wc:*)', 'Bash(cp:*)', 'Bash(stat:*)', 'Bash(find:*)',
        '--disallowedTools', ('Edit({0}/**)' -f ($ClaudeHome -replace '\\','/'))
    )

    $stdout  = Join-Path $Dir ".run-$sid.out"
    $stderr  = Join-Path $Dir ".run-$sid.err"
    $emptyIn = Join-Path $Dir '.empty-stdin'
    Set-Content -LiteralPath $emptyIn -Value '' -NoNewline -Encoding UTF8

    Write-RunLog "starting claude (session $sid, model $Model)"
    Push-Location -LiteralPath $Vault
    try {
        $proc = Start-Process -FilePath $ClaudeExe -ArgumentList $claudeArgs `
                    -WorkingDirectory $Vault -NoNewWindow -PassThru `
                    -RedirectStandardOutput $stdout `
                    -RedirectStandardError  $stderr `
                    -RedirectStandardInput  $emptyIn
    } finally {
        Pop-Location
    }

    # -----------------------------------------------------------------------
    # Watchdog. A run whose transcripts stop moving for $StallMinutes is hung,
    # not thinking. Subagents write their own transcript files, so delegated
    # work counts as activity.
    # -----------------------------------------------------------------------
    $killed = $false
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 60
        if ($proc.HasExited) { break }

        $cutoff = (Get-Date).AddMinutes(-$StallMinutes)
        $active = @(Get-ChildItem -LiteralPath $Projects -Recurse -File -Filter '*.jsonl' `
                        -ErrorAction SilentlyContinue |
                    Where-Object { ($_.BaseName -eq $sid -or $_.Directory.Name -eq $sid) -and
                                   $_.LastWriteTime -gt $cutoff })

        if ($active.Count -eq 0) {
            Write-RunLog "watchdog: session $sid wrote nothing for $StallMinutes minutes; stopping it"
            # A console child has no window to close, so there is no graceful signal
            # to send on Windows. Ask once, then force.
            Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 30
            if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
            $killed = $true
            break
        }
    }
    $proc.WaitForExit()

    foreach ($f in @($stdout, $stderr)) {
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
            Add-Content -LiteralPath $Log -Value (Get-Content -LiteralPath $f -Raw) -Encoding UTF8
        }
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $emptyIn -Force -ErrorAction SilentlyContinue

    if ($killed)              { Stop-WithFailure "the run stalled and was stopped (session $sid)" }
    if ($proc.ExitCode -ne 0) { Stop-WithFailure "claude exited $($proc.ExitCode) (session $sid)" }

    # -----------------------------------------------------------------------
    # A run that stamped nothing did not ingest, whatever its exit code says.
    # This is the check that catches a run reporting success having done nothing.
    # -----------------------------------------------------------------------
    $manifest = Join-Path $Vault '.manifest.json'
    if (-not (Test-Path $manifest) -or (Get-Item $manifest).LastWriteTimeUtc -le $startStamp) {
        Stop-WithFailure 'the run finished without updating .manifest.json'
    }

    # -----------------------------------------------------------------------
    # Consume exactly the turns this run covered. Anything that arrived while
    # it worked survives into the next run.
    # -----------------------------------------------------------------------
    $all = @(Get-Content -LiteralPath $PendingSessions -ErrorAction SilentlyContinue)
    $remaining = if ($all.Count -gt $mark) { $all[$mark..($all.Count - 1)] } else { @() }
    Set-Content -LiteralPath $PendingSessions -Value $remaining -Encoding UTF8
    if ($remaining.Count -eq 0) {
        Remove-Item $PendingFlag -Force -ErrorAction SilentlyContinue
        Write-RunLog 'pending queue cleared'
    } else {
        Write-RunLog ("{0} turn(s) arrived during the run and stay pending" -f $remaining.Count)
    }

    # -----------------------------------------------------------------------
    # Report. Newest log entry by timestamp, wherever the run filed it.
    # -----------------------------------------------------------------------
    $headline = ''
    $logMd = Join-Path $Vault 'log.md'
    if (Test-Path $logMd) {
        $entry = Get-Content -LiteralPath $logMd |
                 Where-Object { $_ -match '^- \[[^\]]*\]\s*CLAUDE' } |
                 Sort-Object -Descending |
                 Select-Object -First 1
        if ($entry) {
            $headline = $entry.Substring(2)
            if ($headline.Length -gt 168) { $headline = $headline.Substring(0, 168) }
        }
    }
    if (-not $headline) { $headline = 'history ingest finished' }

    Write-RunLog "done: $headline"
    Send-Notification $headline
}
finally {
    Remove-Lock
}
