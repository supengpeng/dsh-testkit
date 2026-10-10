<#
Stage 0-D: process-level RSS (peak memory) sampler for D3.

NOTE ON ENCODING (why this file is pure ASCII):
  This host's harness is Windows PowerShell 5.1 with ANSI code page 936 (see
  docs/WINDOWS-ENCODING.md). PS 5.1 decodes a BOM-less script file as ANSI, so
  Chinese literals inside a .ps1 would come out as mojibake -- while the repo's
  encoding guard forbids adding a BOM. Pure ASCII is the only safe combination.
  All Chinese explanation lives in spec/metrics/baseline.md instead.

Measurement protocol:
  - One Node process is measured (-TargetArgs).
  - Every -IntervalMs we poll BOTH:
      WorkingSet64      -> current RSS
      PeakWorkingSet64  -> kernel-tracked peak so far (monotonic while alive)
  - D3 = max(all samples). PeakWorkingSet64 is the stronger reading because it
    is kernel-accounted, not dependent on the sampling frequency; the only gap
    is the final interval before exit (stated in the report as a known limit).
  - exit code and wall time are recorded so a "fast failure" cannot be
    reported as a "fast run".

Usage (from the repo root):
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "& '<repo>\baseline\sample-rss.ps1' -NodePath '<node.exe>' -RepoRoot '<repo>' ^
     -Label scenario-suite -OutJson baseline/rss-scenario-suite.json ^
     -TargetArgs @('--test','--test-isolation=none','export/scenarios.test.mjs')"

Outputs:
  <OutJson>                  machine-readable reading, UTF-8 no BOM
  baseline/rss-<Label>.log     raw stdout of the measured process
  baseline/rss-<Label>.err.log raw stderr (named *.log so .gitignore covers it)
#>
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$OutJson,
  [Parameter(Mandatory = $true)][string[]]$TargetArgs,
  [int]$IntervalMs = 100
)

$ErrorActionPreference = 'Stop'

$logPath = Join-Path $RepoRoot ("baseline/rss-$Label.log")
# Naming note: .gitignore only covers `*.log`, so stderr must also end with `*.log`.
$errPath = Join-Path $RepoRoot ("baseline/rss-$Label.err.log")

$argline = ($TargetArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $NodePath
$psi.Arguments = $argline
$psi.WorkingDirectory = $RepoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()
# Read both pipes asynchronously: draining only after exit can deadlock on a full buffer.
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

$peakWorkingSet = 0L
$peakKernel = 0L
$sampleCount = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while (-not $proc.HasExited) {
  try {
    $proc.Refresh()
    $ws = [long]$proc.WorkingSet64
    $pk = [long]$proc.PeakWorkingSet64
    if ($ws -gt $peakWorkingSet) { $peakWorkingSet = $ws }
    if ($pk -gt $peakKernel) { $peakKernel = $pk }
    $sampleCount++
  }
  catch { }
  Start-Sleep -Milliseconds $IntervalMs
}
$proc.WaitForExit()
$sw.Stop()

$exitCode = $null
try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = $null }

$peak = $peakWorkingSet
if ($peakKernel -gt $peak) { $peak = $peakKernel }

[System.IO.File]::WriteAllText($logPath, [string]$outTask.Result, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($errPath, [string]$errTask.Result, (New-Object System.Text.UTF8Encoding($false)))

$payload = [ordered]@{
  metric         = 'D3'
  label          = $Label
  command        = "$NodePath $argline"
  method         = "process-level RSS sampling: poll WorkingSet64 + kernel PeakWorkingSet64 every ${IntervalMs}ms; D3 = max of samples"
  interval_ms    = $IntervalMs
  sample_size    = $sampleCount
  peak_rss_bytes = $peak
  peak_rss_mib   = [math]::Round($peak / 1MB, 3)
  peak_workset_sampled_mib = [math]::Round($peakWorkingSet / 1MB, 3)
  peak_kernel_sampled_mib  = [math]::Round($peakKernel / 1MB, 3)
  sampling_gap_note = "PeakWorkingSet64 is kernel-accounted but only observed at poll boundaries; the last <${IntervalMs}ms before exit is not sampled"
  exit_code      = $exitCode
  wall_ms        = [math]::Round($sw.Elapsed.TotalMilliseconds, 3)
  generated_at   = (Get-Date -Format o)
}

$absOut = Join-Path $RepoRoot $OutJson
[System.IO.File]::WriteAllText($absOut, (($payload | ConvertTo-Json -Depth 5) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("[D3] " + $Label + " peak=" + $payload.peak_rss_mib + " MiB (workset=" + $payload.peak_workset_sampled_mib + ", kernel=" + $payload.peak_kernel_sampled_mib + ") samples=" + $sampleCount + " exit=" + $exitCode + " wall_ms=" + $payload.wall_ms)
