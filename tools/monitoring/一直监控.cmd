@echo off
rem agent-audit always-on monitor: canary FIRST (fast, independent), then hourly watch block
:loop
rem primary path (agent-audit 0.4.1+): first-class --canary flag, same scan
rem logic and exit codes as the fallback script below
agent-audit --canary --canary-dir "D:\Projects\demo-inventory-sync" > "D:\agent-watch\canary-result.txt" 2>&1
rem fallback (installs without the 0.4.1 CLI flag):
rem node "D:\agent-watch\canary-check.mjs" > "D:\agent-watch\canary-result.txt" 2>&1
call agent-audit --watch --seconds 3600 --csv "D:\agent-watch\egress.csv" >> "D:\agent-watch\run.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
