@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "http://localhost:8899/?sample"
py -3 serve.py
