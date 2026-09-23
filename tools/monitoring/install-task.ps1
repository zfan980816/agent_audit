# 注册 agent-audit 常驻监控开机自启任务(需用户本人执行)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File D:/agent-watch/install-task.ps1
$action = New-ScheduledTaskAction -Execute "D:\agent-watch\一直监控.cmd"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "agent-audit-monitor" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "task registered"
Start-ScheduledTask -TaskName "agent-audit-monitor"
Write-Host "task started"
