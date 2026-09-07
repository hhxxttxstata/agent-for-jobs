@echo off
chcp 65001 >nul
cd /d D:gent-for-jobs
node .pi\skillsesume-pdf\scripts\md2pdf.mjs "dataesumes\AI应用开发.md" --density medium
pause
