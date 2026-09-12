@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  手机扫码直连（独立进程，不会影响 Harness）
echo.
node "%~dp0tools\lan-hop.mjs" %*
echo.
echo  已退出。按任意键关闭窗口。
pause >nul
