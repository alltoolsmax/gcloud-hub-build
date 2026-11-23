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
call npx --yes electron-builder --win nsis --x64 -c.win.signAndEditExecutable=true || (echo [LOI] Build that bai & pause & exit /b 1)
call node tools/make-downloads.js
echo.
echo === XONG! Ban chay thu tren may: %~dp0dist ===
echo Ban phat hanh: GitHub tu build ^(gcloud-hub-build ^> Releases^), Windows toi khach khi bam Phat hanh o trang quan tri.
start "" "%~dp0dist"
pause
