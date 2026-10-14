<#
.SYNOPSIS
  Takes a compressed backup of the TriponX database.

.DESCRIPTION
  Writes a timestamped pg_dump of the database named in DATABASE_URL into
  backups/. Custom format (-Fc) is used rather than plain SQL because it
  restores selectively, compresses, and carries a table of contents pg_restore
  can verify before touching anything.

  Also records a manifest: the dump's SHA-256 and a row-count census of the
  tables that hold business data. The census is what makes a restore
  verifiable — "pg_restore exited 0" proves the file parsed, not that the data
  came back.

.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -Keep 30
#>
[CmdletBinding()]
param(
  # How many dated dumps to keep. Older ones are pruned after a successful dump.
  [int] $Keep = 14
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# ---------------------------------------------------------------- locate tools
function Find-PgTool([string] $Name) {
  $onPath = Get-Command $Name -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $roots = @(
    'C:\Program Files\PostgreSQL',
    'C:\Program Files (x86)\PostgreSQL'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($dir in Get-ChildItem $root -Directory) {
      $candidate = Join-Path $dir.FullName "bin\$Name.exe"
      if (Test-Path $candidate) { return $candidate }
    }
  }
  throw "$Name not found. Install the PostgreSQL client tools or add them to PATH."
}

$pgDump = Find-PgTool 'pg_dump'

# ------------------------------------------------------------------ connection
$envFile = Join-Path (Get-Location) '.env'
if (-not (Test-Path $envFile)) {
  throw ".env not found. Copy .env.example and set DATABASE_URL."
}
$line = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*"?(.*?)"?\s*$' |
  Select-Object -First 1
if (-not $line) { throw 'DATABASE_URL is not set in .env' }

$databaseUrl = $line.Matches[0].Groups[1].Value
if (-not $databaseUrl) { throw 'DATABASE_URL is empty in .env' }

# --------------------------------------------------------------------- output
$backupDir = Join-Path (Get-Location) 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpFile = Join-Path $backupDir "pms-$stamp.dump"
$manifestFile = Join-Path $backupDir "pms-$stamp.manifest.txt"

Write-Host "Backing up to $dumpFile"

# --no-owner and --no-privileges keep the dump restorable by a different role,
# which is the usual reason a backup turns out to be useless.
& $pgDump --dbname $databaseUrl --format custom --compress 9 `
    --no-owner --no-privileges --file $dumpFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

# ------------------------------------------------------------------- manifest
$hash = (Get-FileHash -Path $dumpFile -Algorithm SHA256).Hash.ToLower()

# The table list lives in scripts/census.mjs so the backup and the drill cannot
# disagree about what is being measured.
$rows = @()
# Delegated to a node helper rather than inline psql calls: PowerShell's argument
# passing to psql dropped flags silently during testing, and a census that
# quietly reports the wrong number is worse than none.
$censusJson = & node scripts/census.mjs --strict
if ($LASTEXITCODE -ne 0) { throw "census failed - a table in the list is missing: $censusJson" }
$censusData = $censusJson | ConvertFrom-Json
foreach ($prop in $censusData.PSObject.Properties) {
  $rows += ('{0,-24} {1}' -f $prop.Name, $prop.Value)
}

$manifest = @(
  "backup taken : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "source       : $([System.Uri]$databaseUrl -replace ':[^:@/]*@', ':***@')",
  "file         : $(Split-Path -Leaf $dumpFile)",
  "bytes        : $((Get-Item $dumpFile).Length)",
  "sha256       : $hash",
  '',
  'row counts'
) + ($rows | ForEach-Object { "  $_" })

$manifest | Set-Content -Path $manifestFile -Encoding utf8

# ---------------------------------------------------------------------- prune
Get-ChildItem $backupDir -Filter 'pms-*.dump' |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep |
  Remove-Item -Force
Get-ChildItem $backupDir -Filter 'pms-*.manifest.txt' |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep |
  Remove-Item -Force

Write-Host ''
Write-Host "Backup complete: $dumpFile"
Write-Host "sha256 $hash"
Write-Host "manifest: $manifestFile"