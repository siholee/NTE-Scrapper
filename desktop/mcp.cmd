@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
if not defined NTE_DATA_DIR set "NTE_DATA_DIR=%APPDATA%\NTE Scrapper\data"
"%~dp0NTE Scrapper.exe" "%~dp0resources\app\src\server.js"
