@echo off
rem Switch back to the previous installed version (zhuyin.prev).
rem Double-click this file. See docs\PIME-INSTALL.md.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" rollback
