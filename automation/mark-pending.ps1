#Requires -Version 5.1
<#
    Claude Code Stop-hook target. Fires once per ended turn.

    Records that there is work for the next ingest: a flag file the runner gates on,
    and one line per turn so the runner can consume exactly what it covered and leave
    anything that arrived mid-run pending.

    Must stay fast and must never fail — a hook that errors interrupts the session.
#>
try {
    $dir = Join-Path $env:USERPROFILE '.obsidian-wiki'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -LiteralPath (Join-Path $dir '.pending_ingest') -Value '' -NoNewline -ErrorAction Stop
    Add-Content -LiteralPath (Join-Path $dir '.pending_sessions') `
                -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -ErrorAction Stop
} catch {
    # Silent by design. Losing one pending marker costs a delayed ingest;
    # failing here costs the user's session.
}
exit 0
