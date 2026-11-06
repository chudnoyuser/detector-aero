<#
  Показывает всплывающее уведомление Windows от имени «Детектор АЭРО».
  Сначала пробует настоящий toast (WinRT), если он недоступен — показывает
  системный «шарик» в трее. Вызывается из watch.mjs, отдельно запускать не нужно.

  Параметры:
    -Title "заголовок"
    -Body  "текст"
#>
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body
)

$ErrorActionPreference = 'Stop'
$AppId = 'DetectorAero.Watch'

function Show-WinRtToast {
    # Регистрируем приложение в HKCU, иначе Windows молча съедает уведомление.
    $regPath = "HKCU:\Software\Classes\AppUserModelId\$AppId"
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
        New-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'Детектор АЭРО' -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $regPath -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
    }

    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $template.GetElementsByTagName('text')
    $nodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $nodes.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null

    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(30)

    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
    $notifier.Show($toast)
}

function Show-Balloon {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Warning
    $icon.Visible = $true
    $icon.BalloonTipTitle = $Title
    $icon.BalloonTipText = $Body
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $icon.ShowBalloonTip(10000)
    Start-Sleep -Seconds 4
    $icon.Dispose()
}

try {
    Show-WinRtToast
    Write-Output 'toast'
}
catch {
    try {
        Show-Balloon
        Write-Output 'balloon'
    }
    catch {
        Write-Output 'failed'
        exit 1
    }
}
