@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  install-skills.cmd - install the agent skills into the local DSH roots.
rem  NOTE: this file must stay pure ASCII. A .cmd with UTF-8 Cyrillic fails with
rem  "The syntax of the command is incorrect" (verified with and without BOM).
rem ---------------------------------------------------------------------------

set "SRC=%~dp0skills"

if not exist "%SRC%" (
  echo [ERROR] skills folder not found: "%SRC%"
  exit /b 1
)

echo Installing skills from:
echo   %SRC%
echo.

for %%T in ("%USERPROFILE%\.dsh\skills" "%USERPROFILE%\.agents\skills") do (
  echo Target: %%~T
  if not exist "%%~T" mkdir "%%~T"
  for %%S in (figma-bridge ux-ui-design) do (
    xcopy "%SRC%\%%S" "%%~T\%%S" /E /I /Y /Q >nul
    if errorlevel 1 (
      echo   [FAIL] %%S
    ) else (
      if exist "%%~T\%%S\__pycache__" rd /s /q "%%~T\%%S\__pycache__"
      echo   [ ok ] %%S
    )
  )
  echo.
)

echo Done. The agent picks up new skills immediately - no restart needed.
echo Skills will also be found in .dsh\skills and .agents\skills inside a project.
endlocal
