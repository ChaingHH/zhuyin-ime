@echo off
rem Remove zhuyin-native from PIME.
rem Double-click this file. See docs\PIME-INSTALL.md.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" uninstall
