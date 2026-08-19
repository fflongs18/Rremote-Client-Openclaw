@echo off
set "REMOTE_CLIENT_CONFIG=%USERPROFILE%\.remote-oc\device.json"
"%~dp0runtime\node.exe" "%~dp0app\client\dist\index.js"
