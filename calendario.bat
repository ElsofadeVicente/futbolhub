@echo off
REM ============================================================
REM  calendario.bat - Que dia esta sirviendo hoy cada juego diario.
REM  Doble clic aqui y te dice, de La Carrera, El Crucigrama, En el
REM  Top y En el Once: si tienen la edicion de hoy, cuantos dias
REM  llevan atrasados y cuando cae el proximo hueco.
REM
REM  Sin red (solo lo que hay en disco):  calendario.bat --local
REM  Mirando mas dias hacia delante:      calendario.bat --dias 60
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
python admin\estado_calendario.py %*
echo.
pause
