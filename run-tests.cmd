@echo off
rem ---------------------------------------------------------------
rem  Web to Figma - full test run.
rem  IMPORTANT: keep this file pure ASCII. A .cmd containing UTF-8
rem  Cyrillic fails with "The syntax of the command is incorrect".
rem ---------------------------------------------------------------

chcp 65001 >nul
title Web to Figma - tests
cd /d "%~dp0"

set FAILED=0

echo.
echo   [1/10] Chrome and DevTools Protocol...
node test\smoke-browser.js || set FAILED=1
echo.

echo   [2/10] Serializer: geometry against the live DOM...
node test\test-serialize.js || set FAILED=1
echo.

echo   [3/10] Converter: browser - IR - Figma tree...
node test\test-converter.js || set FAILED=1
echo.

echo   [4/10] Code import and agent design build...
node test\test-code-and-agent.js || set FAILED=1
echo.

echo   [5/10] Image normalization (AVIF and SVG to PNG/JPEG)...
node test\test-image-normalize.js || set FAILED=1
echo.

echo   [6/10] Degradation when Figma lacks GRID layout...
node test\test-grid-unsupported.js || set FAILED=1
echo.

echo   [7/10] Bridge: HTTP and WebSocket...
node test\test-server.js || set FAILED=1
echo.

echo   [8/10] Plugin UI in a real browser...
node test\test-ui.js || set FAILED=1
echo.

echo   [9/10] Visual comparison with the original page...
node test\test-visual.js || set FAILED=1
echo.

echo   [10/10] Heavy page (needs network)...
node test\test-converter-big.js https://tailwindcss.com/ 1440 || set FAILED=1
echo.

if "%FAILED%"=="1" (
  echo   SOME TESTS FAILED
) else (
  echo   All tests passed.
)
echo.
pause
