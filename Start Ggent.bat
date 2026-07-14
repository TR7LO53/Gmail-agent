@echo off
title Ggent
cd /d "%~dp0gmail-agent"
echo Starting Ggent... a browser window will open in a few seconds.
echo (Close this window to stop Ggent.)
echo.
call npm start
echo.
echo Ggent has stopped.
pause
