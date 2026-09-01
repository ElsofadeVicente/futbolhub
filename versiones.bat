@echo off
REM ============================================================
REM  versiones.bat - Las dos comprobaciones de antes de desplegar.
REM
REM  1) LOS ?v=
REM  Desde el 2026-08-31 Vercel sirve el JS y el CSS con ?v= como
REM  inmutables durante un ano (quita ~21 idas y vueltas por carga).
REM  El precio: si tocas un archivo y NO le subes el ?v=, la gente
REM  se queda con el viejo un ano entero, y sin ningun aviso.
REM
REM  2) LOS HASHES DE LA CSP
REM  La Carrera lleva una CSP de bloqueo: cada <script> en linea y
REM  cada <style> inyectado va autorizado por el hash de su
REM  contenido. Cambiar ahi un solo espacio invalida el hash y el
REM  navegador lo bloquea... solo en produccion, porque en local no
REM  hay CSP. Se ve abriendo la consola y de ninguna otra forma.
REM
REM  Doble clic aqui antes de subir cambios.
REM  Cuando este todo bien:  versiones.bat --actualizar
REM ============================================================
cd /d "%~dp0"
python admin\comprobar_versiones.py %*
python admin\comprobar_csp.py %*
echo.
pause
