@echo off
REM ============================================================
REM  versiones.bat - Comprueba los ?v= antes de desplegar.
REM
REM  Desde el 2026-08-31 Vercel sirve el JS y el CSS con ?v= como
REM  inmutables durante un ano (quita ~21 idas y vueltas por carga).
REM  El precio: si tocas un archivo y NO le subes el ?v=, la gente
REM  se queda con el viejo un ano entero, y sin ningun aviso.
REM
REM  Doble clic aqui antes de subir cambios: avisa de los archivos
REM  que han cambiado sin subir su version, de los que se sirven con
REM  dos ?v= distintos y de las referencias rotas.
REM
REM  Cuando este todo bien:  versiones.bat --actualizar
REM ============================================================
cd /d "%~dp0"
python admin\comprobar_versiones.py %*
echo.
pause
