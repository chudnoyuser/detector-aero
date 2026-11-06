<#
  Установка наблюдателя Детектор АЭРО в автозапуск Windows.

  Что делает:
    1) регистрирует приложение «Детектор АЭРО» для настоящих toast-уведомлений;
    2) кладёт ярлык в папку «Автозагрузка» текущего пользователя;
    3) по ключу -StartNow сразу запускает наблюдатель.

  Использование (обычный PowerShell, без администратора):
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -StartNow
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
#>
param(
    [switch]$StartNow,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'start-watch.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Детектор АЭРО (воздушная опасность).lnk'
$appId = 'DetectorAero.Watch'

if ($Uninstall) {
    if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }
    $reg = "HKCU:\Software\Classes\AppUserModelId\$appId"
    if (Test-Path $reg) { Remove-Item $reg -Recurse -Force }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*watch.mjs*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host 'Автозапуск удалён, наблюдатель остановлен.' -ForegroundColor Yellow
    return
}

if (-not (Test-Path $vbs)) { throw "Не найден $vbs" }

# 1. Регистрация AppUserModelId — без неё Windows не показывает toast
$reg = "HKCU:\Software\Classes\AppUserModelId\$appId"
if (-not (Test-Path $reg)) {
    New-Item -Path $reg -Force | Out-Null
    New-ItemProperty -Path $reg -Name 'DisplayName' -Value 'Детектор АЭРО' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $reg -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
    Write-Host 'Зарегистрировано приложение для уведомлений Windows.' -ForegroundColor Green
}

# 2. Ярлык в автозагрузке
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = $here
$lnk.WindowStyle = 7
$lnk.Description = 'Детектор АЭРО — уведомления о воздушной опасности'
$lnk.Save()
Write-Host "Ярлык добавлен в автозагрузку: $lnkPath" -ForegroundColor Green

# 3. Запуск сейчас
if ($StartNow) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*watch.mjs*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Write-Host 'Наблюдатель запущен.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Проверить состояние:  node "' -NoNewline
Write-Host (Join-Path $here 'watch.mjs') -NoNewline
Write-Host '" --status'
Write-Host 'Логи:                 ' -NoNewline
Write-Host (Join-Path $here 'logs')
