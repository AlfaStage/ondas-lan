@echo off
chcp 65001 >nul
title ONDAS LAN - Hub de Audio (PC para iPhone/Android)

echo ====================================================================
echo   ONDAS LAN // HUB DE AUDIO MULTI-DISPOSITIVOS (PC -^> iPhone/Android)
echo ====================================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Node.js nao foi encontrado no seu Windows!
    echo Baixe e instale gratuitamente em: https://nodejs.org/
    pause
    exit /b 1
)

echo Iniciando servidor de audio na rede local (Porta 3000)...
echo Abrindo o painel no navegador do seu PC...
start "" "http://localhost:3000"

node server.js
pause
