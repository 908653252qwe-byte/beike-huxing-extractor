@echo off
title 贝壳找房 - 户型提取工具
echo ========================================
echo   贝壳找房 户型信息提取工具
echo ========================================
echo.
echo 正在启动服务...
echo.

cd /d "%~dp0"
node server.js

if errorlevel 1 (
    echo.
    echo 启动失败！请确保已安装 Node.js
    pause
)
