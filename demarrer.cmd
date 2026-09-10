@echo off
title Seance synchronisee
cd /d "%~dp0"

rem Node portable installe a cote, sinon celui du systeme.
set "NODE=%LOCALAPPDATA%\Programs\node-v24.19.0-win-x64\node.exe"
if not exist "%NODE%" set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"

where /q "%NODE%" 2>nul || if not exist "%NODE%" (
  echo.
  echo   Node.js est introuvable.
  echo.
  echo   Sans droits administrateur : telecharge le zip "Windows Binary x64"
  echo   sur https://nodejs.org/fr/download , dezippe-le, et renomme le
  echo   dossier obtenu en "node" a cote de ce fichier.
  echo.
  pause
  exit /b 1
)

echo.
echo   Demarrage de la seance... la page s'ouvre toute seule.
echo   Garde cette fenetre ouverte pendant la seance.
echo.

rem --ouvrir : le serveur ouvre le navigateur sur la bonne adresse, cle comprise.
"%NODE%" server.js --ouvrir

echo.
echo   Le serveur s'est arrete.
pause
