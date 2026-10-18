@echo off
rem Build a single Setup.exe (native\pime\dist\zhuyin-native-setup.exe). Needs Rust and Inno Setup 6.
rem Does not touch this computer's PIME. See docs\PIME-INSTALL.md.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-setup.ps1"
