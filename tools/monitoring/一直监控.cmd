@echo off
rem agent-audit always-on monitor: hourly watch block + canary check, never stop
:loop
call agent-audit --watch --seconds 3600 --csv "D:\agent-watch\egress.csv" >> "D:\agent-watch\run.log" 2>&1
node "D:\agent-watch\canary-check.mjs" >> "D:\agent-watch\canary-result.txt" 2>&1
timeout /t 3 /nobreak >nul
goto loop
