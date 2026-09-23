@echo off
chcp 65001 >nul
title 金丝雀检查 - 有没有工具偷扫你的项目
node "D:\agent-watch\canary-check.mjs"
echo.
pause
