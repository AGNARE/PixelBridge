@echo off
rem ---------------------------------------------------------------
rem  Web to Figma - capture engine launcher.
rem
rem  IMPORTANT: this file must stay pure ASCII.
rem  A .cmd containing UTF-8 Cyrillic fails with
rem  "The syntax of the command is incorrect" - verified by test,
rem  both with and without BOM. Russian guidance is printed by
rem  Node.js instead (see engine/server.js startup log).
rem ---------------------------------------------------------------

chcp 65001 >nul
title Web to Figma - capture engine
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0engine\server.js"

echo.
echo   Engine stopped.
pause
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install it from https://nodejs.org - version 20 or newer.
echo.
pause
exit /b 1
