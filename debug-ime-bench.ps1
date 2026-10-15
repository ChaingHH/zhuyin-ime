param([ValidateSet('ms', 'chewing', 'mcbopomofo')][string]$Ime, [string]$Keys, [string]$Out, [int]$Limit = 0, [int]$Skip = 0)
# 包住 debug-ms-bopomofo.ps1：打字前後記錄輸入法引擎所在行程的 CPU 時間與記憶體。
# 會佔用鍵盤與前景視窗，使用者不在電腦前才能跑。結果附加到 <Out>.proc.txt。
$ids = @{
  ms         = @('B115690A-EA02-48D5-A231-E3578D2FDF80', 'B2F9C502-1742-11D4-9790-0080C882687E')
  chewing    = @('35F67E9D-A54D-4177-9697-8B0AB71A9E04', 'F80736AA-28DB-423A-92C9-5540F501C939')
  mcbopomofo = @('35F67E9D-A54D-4177-9697-8B0AB71A9E04', '5340C1D9-706E-4B6B-B022-2E763FA5F674')
}
# 微軟注音的引擎在 ctfmon（見 docs/MEMORY.md）；PIME 的在啟動器與它開的後端
function Hosts {
  if ($Ime -eq 'ms') { return @(Get-Process ctfmon -ErrorAction SilentlyContinue) }
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -like '*\PIME\*' } catch { $false } })
}
function Snap($label) {
  $rows = foreach ($p in Hosts) {
    $p.Refresh()
    '{0,-14} pid={1,-6} cpu={2,9:F0}ms ws={3,6:F1}MB private={4,6:F1}MB peakWS={5,6:F1}MB' -f $p.ProcessName, $p.Id,
      $p.TotalProcessorTime.TotalMilliseconds, ($p.WorkingSet64 / 1MB), ($p.PrivateMemorySize64 / 1MB), ($p.PeakWorkingSet64 / 1MB)
  }
  "== $label $(Get-Date -Format HH:mm:ss)"
  if ($rows) { $rows } else { '(沒有引擎行程)' }
}
$log = "$Out.proc.txt"
"### $Ime" | Out-File $log -Append -Encoding utf8
Snap 'before' | Out-File $log -Append -Encoding utf8
$cpu0 = 0; foreach ($p in Hosts) { $cpu0 += $p.TotalProcessorTime.TotalMilliseconds }
powershell -STA -ExecutionPolicy Bypass -File "$PSScriptRoot\debug-ms-bopomofo.ps1" -Keys $Keys -Out $Out -Limit $Limit -Skip $Skip -KeyDelay 2 -Clsid $ids[$Ime][0] -ImeProfile $ids[$Ime][1]
Snap 'after' | Out-File $log -Append -Encoding utf8
$cpu1 = 0; foreach ($p in Hosts) { $cpu1 += $p.TotalProcessorTime.TotalMilliseconds }
$keys = (Get-Content $Out -Encoding UTF8 | ForEach-Object { $_.Split("`t")[1] } | Measure-Object).Count
"cpu delta {0:F0}ms over {1} sentences" -f ($cpu1 - $cpu0), $keys | Out-File $log -Append -Encoding utf8
Get-Content $log -Tail 12
