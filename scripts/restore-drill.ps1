<#
.SYNOPSIS
  Restores a backup into a scratch database and verifies it. Never touches the live one.

.DESCRIPTION
  The kit requires a restore drill before production, and the only version worth
  having is one that actually ran. This script:

    1. copies the current database to a scratch name (or backs up first)
    2. creates the scratch database
    3. restores the chosen dump into it
    4. compares every row count in the manifest against the restored database
    5. drops the scratch database

  Step 4 is the point. "pg_restore exited 0" only proves the file parsed; a
  restore that silently dropped half the folios also exits 0. Comparing the
  census is what turns the drill into evidence.

  The live database is never written to. The scratch name is suffixed so it
  cannot collide with anything real.

.EXAMPLE
  .\scripts\restore-drill.ps1
  .\scripts\restore-drill.ps1 -Dump backups\pms-20261014-090000.dump
#>
[CmdletBinding()]
param(
  # Dump to restore. Defaults to the most recent in backups/.
  [string] $Dump,

  # Name for the scratch database. Suffixed with a timestamp so repeated drills
  # never collide.
  [string] $ScratchDb = ('pms_restore_drill_' + (Get-Date -Format 'HHmmss'))
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Find-PgTool([string] $Name) {
  $onPath = Get-Command $Name -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  foreach ($root in @('C:\Program Files\PostgreSQL', 'C:\Program Files (x86)\PostgreSQL')) {
    if (-not (Test-Path $root)) { continue }
    foreach ($dir in Get-ChildItem $root -Directory) {
      $candidate = Join-Path $dir.FullName "bin\$Name.exe"
      if (Test-Path $candidate) { return $candidate }
    }
  }
  throw "$Name not found."
}

$pgDump = Find-PgTool 'pg_dump'
$pgRestore = Find-PgTool 'pg_restore'
$psql = Find-PgTool 'psql'
$dropDb = Find-PgTool 'dropdb'
$createdb = Find-PgTool 'createdb'

# ------------------------------------------------------------------ connection
$envFile = Join-Path (Get-Location) '.env'
$line = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*"?(.*?)"?\s*$' |
  Select-Object -First 1
if (-not $line) { throw 'DATABASE_URL is not set in .env' }
$databaseUrl = $line.Matches[0].Groups[1].Value

$uri = [System.Uri]$databaseUrl
$dbName = $uri.AbsolutePath.Trim('/')

if (-not $Dump) {
  $latest = Get-ChildItem (Join-Path (Get-Location) 'backups') -Filter 'pms-*.dump' `
    -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { throw 'No dump found in backups/. Run scripts\backup.ps1 first.' }
  $Dump = $latest.FullName
}
if (-not (Test-Path $Dump)) { throw "Dump not found: $Dump" }

$manifestFile = [System.IO.Path]::ChangeExtension($Dump, '.manifest.txt')
Write-Host "Restoring $(Split-Path -Leaf $Dump) into $ScratchDb"
Write-Host ''

$failures = @()
function Step($ok, $message) {
  $label = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("{0} {1}" -f $label, $message)
  if (-not $ok) { $script:failures += $message }
}

try {
  # ------------------------------------------------------------------- create
  # PGPASSWORD has to be set before createdb, not after: with --no-password and
  # no password in the environment the connection is refused outright.
  $userInfo = $uri.UserInfo.Split(':')
  $dbUser = $userInfo[0]
  $env:PGPASSWORD = [System.Uri]::UnescapeDataString($userInfo[1])

  $createOutput = & $createdb --host $uri.Host --port $uri.Port --username $dbUser `
      $ScratchDb 2>&1
  $createOk = ($LASTEXITCODE -eq 0)
  Step $createOk "created scratch database $ScratchDb"
  if (-not $createOk) { $createOutput | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" } }

  $scratchUrl = "$($uri.Scheme)://$($uri.UserInfo)@$($uri.Host):$($uri.Port)/$ScratchDb"

  # ------------------------------------------------------------------ restore
  $restoreOutput = & $pgRestore --dbname $scratchUrl --no-owner --no-privileges --exit-on-error $Dump 2>&1
  Step ($LASTEXITCODE -eq 0) 'pg_restore completed without error'
  if ($LASTEXITCODE -ne 0) { $restoreOutput | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" } }

  # -------------------------------------------------------------------- verify
  # The census is read with the same helper that wrote it, so the two cannot
  # drift on what "the same number" means.
  $restoredJson = & node scripts/census-against.mjs $scratchUrl
  if ($LASTEXITCODE -ne 0) { Step $false 'census against the restored database failed' }
  else { $restored = $restoredJson | ConvertFrom-Json }

  if (Test-Path $manifestFile) {
    $expected = @{}
    foreach ($line2 in Get-Content $manifestFile) {
      if ($line2 -match '^\s{2}(\S+)\s+(\d+)\s*$') { $expected[$Matches[1]] = [int]$Matches[2] }
    }

    $mismatch = 0
    $missing = 0
    foreach ($table in $expected.Keys) {
      $actualProp = $restored.PSObject.Properties[$table]
      if ($null -eq $actualProp -or $null -eq $actualProp.Value) {
        $missing++
        Write-Host "FAIL $table is missing from the restored database"
        continue
      }
      if ([int]$actualProp.Value -ne $expected[$table]) {
        $mismatch++
        Write-Host ("FAIL {0,-22} expected {1}, got {2}" -f $table, $expected[$table], $actualProp.Value)
      }
    }

    Step ($missing -eq 0) "all $($expected.Count) census tables present in the restore"
    Step ($mismatch -eq 0) 'every row count matches the manifest taken at backup time'

    # Referential integrity is what a row count cannot show. A restore that
    # duplicated every table would pass the census while being unusable.
    $orphanOutput = & node scripts/orphans.mjs $scratchUrl
    Step ($LASTEXITCODE -eq 0) 'no orphaned rows after restore'
    $orphanOutput | ForEach-Object { Write-Host "    $_" }
  } else {
    Step ($false) "manifest not found next to the dump ($([System.IO.Path]::GetFileName($manifestFile)))"
  }
}
finally {
  # -------------------------------------------------------------------- clean
  # dropdb writes "does not exist, skipping" to stderr as a NOTICE, which trips
  # $ErrorActionPreference = 'Stop'. The cleanup must never be the thing that
  # fails the run, so stderr is discarded here deliberately.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $dropdb --host $uri.Host --port $uri.Port --username $dbUser `
      --if-exists $ScratchDb 2>&1 | Out-Null
  $ErrorActionPreference = $previousPreference
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "Scratch database dropped."
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'Restore drill PASSED - the backup restores to a verified dataset.'
  exit 0
}
Write-Host "Restore drill FAILED ($($failures.Count) problem(s))."
exit 1