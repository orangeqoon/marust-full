# 丸スト: OBS 用プラグインを写す（L5b）。管理者で動かす処理。受け取るのは同梱の場所 -Src と入れる場所 -Dst の 2 つだけ。
# 管理者でなければ、自分自身を管理者で 1 回だけ起こし直す（UAC の窓が 1 回出る）。断られたら終了コード 2。
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'

$dstFull = [System.IO.Path]::GetFullPath($Dst).TrimEnd('\')
if ($dstFull -notmatch '\\obs-studio\\plugins\\obs-multi-rtmp$') { exit 3 }
if ($Src -match '["''`$%]' -or $Dst -match '["''`$%]') { exit 3 }

if (-not $Elevated) {
  try {
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Src', ('"' + $Src + '"'), '-Dst', ('"' + $Dst + '"'), '-Elevated')
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $argList
    exit $p.ExitCode
  } catch {
    exit 2
  }
}

try {
  $dll = Join-Path $Src 'obs-multi-rtmp.dll'
  if (-not (Test-Path -LiteralPath $dll)) { exit 4 }
  $binDir = Join-Path $Dst 'bin\64bit'
  $locDir = Join-Path $Dst 'data\locale'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  New-Item -ItemType Directory -Force -Path $locDir | Out-Null
  Copy-Item -LiteralPath $dll -Destination (Join-Path $binDir 'obs-multi-rtmp.dll') -Force
  $srcLoc = Join-Path $Src 'data\locale'
  if (Test-Path -LiteralPath $srcLoc) {
    Get-ChildItem -LiteralPath $srcLoc -Filter '*.ini' -File | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $locDir $_.Name) -Force
    }
  }
  exit 0
} catch {
  exit 1
}
