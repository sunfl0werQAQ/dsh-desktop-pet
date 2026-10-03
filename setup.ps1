<#
    大肥鱼桌宠 · 本地端 —— 一键组装脚本
    ------------------------------------------------------------------
    做三件事：
      1. 从 npmmirror 下载 Electron 运行时（默认 43.3.0，win32-x64）
      2. 解压到 ./runtime/
      3. 把 ./app/ 放进 runtime/resources/app/，并把 electron.exe 改名
    完成后双击 runtime\大肥鱼桌宠.exe 即可运行。

    用法：  powershell -ExecutionPolicy Bypass -File .\setup.ps1
#>

$ErrorActionPreference = 'Stop'

$Version = '43.3.0'
$Mirror  = 'https://npmmirror.com/mirrors/electron/'
$Root    = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }

$Zip     = Join-Path $Root "electron-v$Version-win32-x64.zip"
$Runtime = Join-Path $Root 'runtime'
$Url     = "$Mirror$Version/electron-v$Version-win32-x64.zip"

Write-Host ''
Write-Host '大肥鱼桌宠 · 本地端   组装脚本' -ForegroundColor Cyan
Write-Host "Electron $Version (win32-x64)" -ForegroundColor DarkGray
Write-Host ''

# ── 1. 下载（已有运行时则跳过）────────────────────────────────
$ExistingExe = @(
    (Join-Path $Runtime 'electron.exe'),
    (Join-Path $Runtime '大肥鱼桌宠.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($ExistingExe -and (Test-Path (Join-Path $Runtime 'resources\app\bootstrap.js'))) {
    Write-Host '[1/4] 检测到已有 runtime/，跳过下载' -ForegroundColor Yellow
} else {
    Write-Host "[1/4] 下载 Electron ..."
    Write-Host "      $Url" -ForegroundColor DarkGray
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Zip
    Write-Host ('      完成：{0:N1} MB' -f ((Get-Item $Zip).Length / 1MB)) -ForegroundColor Green

    Write-Host '[2/4] 解压 ...'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Runtime)
    Remove-Item $Zip -Force
    Write-Host '      完成' -ForegroundColor Green
}

# ── 3. 放置 app ───────────────────────────────────────────────
Write-Host '[3/4] 放置 app/ ...'
$AppDir = Join-Path $Runtime 'resources\app'
if (-not (Test-Path (Join-Path $Root 'app'))) { throw "找不到 app/ 目录，请在仓库根目录运行本脚本。" }
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Copy-Item (Join-Path $Root 'app') $AppDir -Recurse
Write-Host '      完成' -ForegroundColor Green

# ── 4. 改名 ───────────────────────────────────────────────────
Write-Host '[4/4] 重命名入口 ...'
$Exe = Join-Path $Runtime 'electron.exe'
$New = Join-Path $Runtime '大肥鱼桌宠.exe'
if (Test-Path $Exe) { Rename-Item $Exe $New -Force }
elseif ($ExistingExe) { $New = $ExistingExe }
Write-Host '      完成' -ForegroundColor Green

Write-Host ''
Write-Host '组装完成！双击运行：' -ForegroundColor Green
Write-Host "  $New" -ForegroundColor Green
Write-Host ''
Write-Host '提示：退出请用任务栏右下角的托盘图标 → 右键 → 退出。' -ForegroundColor DarkGray
Write-Host ''
