@echo off
chcp 65001 >nul
title chat-soul-bridge - 初始化与多 Bot 配置向导
cd /d "%~dp0"
echo Launching chat-soul-bridge setup wizard...
npm run init
pause
