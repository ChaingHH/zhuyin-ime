@echo off
rem Install or update zhuyin-native into PIME (asks for administrator rights once).
rem Double-click this file. See docs\PIME-INSTALL.md.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" install
