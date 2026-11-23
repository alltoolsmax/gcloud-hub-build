@echo off
chcp 65001 >nul
REM Luon chay trong thu muc chua file .bat (ke ca khi "Run as administrator")
cd /d "%~dp0"
if not exist package.json (
  echo [LOI] Khong tim thay package.json. Hay giai nen toan bo file zip roi chay lai.
  pause & exit /b 1
)
where node >nul 2>nul || (echo [LOI] Chua cai Node.js. Tai tai https://nodejs.org ^(ban LTS^) roi chay lai. & pause & exit /b 1)
echo === Cai dat thu vien... ===
call npm install || (echo [LOI] npm install that bai & pause & exit /b 1)
echo === Dang build file .exe... ===
call npx --yes electron-builder --win portable nsis --x64 -c.win.signAndEditExecutable=true || (echo [LOI] Build that bai & pause & exit /b 1)
call node tools/make-latest.js "" >nul 2>&1
echo.
echo === XONG! File .exe nam trong: %~dp0dist ===
start "" "%~dp0dist"
pause
