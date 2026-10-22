# 做出單一 Setup.exe（dist\zhuyin-native-setup.exe），給沒有 repo、沒有 Rust 的人用。一般權限即可：
#   1. cargo build --release
#   2. install.ps1 -Stage dist（組出 dist\zhuyin\）
#   3. 下載內附的 PIME 安裝檔（native\pime\vendor\，驗 SHA-256）
#   4. Inno Setup 6 的 ISCC.exe 編 setup.iss
# 只組檔案、編安裝程式，不動這台電腦的 PIME。build-setup.cmd 會呼叫這支。
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$native = Split-Path $here
$data = if ($env:ZHUYIN_DATA) { $env:ZHUYIN_DATA.TrimEnd([char]92) } else { Join-Path (Split-Path $native) 'data' }

function Done([bool]$ok, [string]$msg) {
  Write-Host ''
  if ($ok) { Write-Host "✔ $msg" -ForegroundColor Green } else { Write-Host "✘ $msg" -ForegroundColor Red }
  Read-Host '按 Enter 關閉這個視窗' | Out-Null
  exit ([int](-not $ok))
}

try {
  Push-Location $native
  & cargo build --release
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Done $false '建置失敗（需要 Rust：https://rustup.rs）。' }

  $dist = Join-Path $here 'dist'
  if (Test-Path (Join-Path $dist 'zhuyin')) { Remove-Item -Recurse -Force (Join-Path $dist 'zhuyin') }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'install.ps1') -Stage $dist -Data $data
  if ($LASTEXITCODE -ne 0) { Done $false '組出安裝檔失敗。' }

  # 內附的 PIME 官方安裝檔（setup.iss 在對方沒有 PIME 時靜默安裝）。沒有就下載，雜湊對不上就不編
  $pime = Join-Path $here 'vendor\PIME-2.0.0-beta3-setup.exe'
  $pimeHash = '73D86806C1C21416F67266D8BECAF0A14D3C260E20AF316BD4EBE871FDBC95B5'
  if (-not (Test-Path $pime)) {
    New-Item -ItemType Directory -Force (Split-Path $pime) | Out-Null
    Invoke-WebRequest -UseBasicParsing -OutFile $pime 'https://github.com/EasyIME/PIME/releases/download/v2.0.0-beta3/PIME-2.0.0-beta3-setup.exe'
  }
  if ((Get-FileHash $pime).Hash -ne $pimeHash) { Done $false "$pime 的 SHA-256 不對，刪掉再執行一次。" }

  $iscc = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $iscc) {
    Done $false "找不到 Inno Setup 6（ISCC.exe）。檔案已組到 $dist\zhuyin\；裝好 Inno Setup 6 後再執行一次（https://jrsoftware.org/isdl.php）。"
  }
  & $iscc (Join-Path $here 'setup.iss')
  if ($LASTEXITCODE -ne 0) { Done $false 'Inno Setup 編譯失敗，見上面的訊息。' }
  Done $true "完成：$dist\zhuyin-native-setup.exe"
} catch {
  Done $false "發生錯誤：$($_.Exception.Message)"
}
