# ===== obsidian-wiki =====================================================
# Added by the Obsidian vault kit. Two things:
#   1. a greeting showing how much Claude activity is waiting to be ingested
#   2. `wiki-history` to run the ingest by hand
#
# The Stop hook writes the pending markers; the scheduled task drains them.

$script:ObsidianWikiDir = Join-Path $env:USERPROFILE '.obsidian-wiki'

function Get-WikiPending {
    $f = Join-Path $script:ObsidianWikiDir '.pending_sessions'
    if (Test-Path $f) { @(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue).Count } else { 0 }
}

function Show-WikiPending {
    if (Test-Path (Join-Path $script:ObsidianWikiDir '.pending_ingest')) {
        $n = Get-WikiPending
        Write-Host ("[wiki] {0} Claude turn(s) since the last history ingest " -f $n) -NoNewline -ForegroundColor DarkYellow
        Write-Host "(runs daily; now: wiki-history)" -ForegroundColor DarkGray
    }
}

function wiki-history {
    <#  wiki-history          ingest only if turns are pending
        wiki-history -Force   ingest regardless  #>
    param([switch]$Force)
    & (Join-Path $script:ObsidianWikiDir 'run-ingest.ps1') @PSBoundParameters
}

function wiki-log {
    <# Tail today's ingest log. #>
    param([int]$Lines = 40)
    $f = Join-Path $script:ObsidianWikiDir ("logs\{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
    if (Test-Path $f) { Get-Content -LiteralPath $f -Tail $Lines } else { Write-Host "No log for today yet." }
}

Show-WikiPending
# ===== end obsidian-wiki =================================================
