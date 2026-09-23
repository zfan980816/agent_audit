@echo off
rem agent-audit always-on monitor: canary FIRST (fast, independent), then hourly watch block
:loop
node "D:\agent-watch\canary-check.mjs" > "D:\agent-watch\canary-result.txt" 2>&1
call agent-audit --watch --seconds 3600 --csv "D:\agent-watch\egress.csv" >> "D:\agent-watch\run.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
