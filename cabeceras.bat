@echo off
REM ============================================================
REM  cabeceras.bat - La comprobacion de DESPUES de desplegar.
REM
REM  versiones.bat mira los archivos del disco ANTES de subir.
REM  Esto mira lo que Vercel esta sirviendo de verdad DESPUES.
REM
REM  Lo que vigila es el arreglo del 2026-09-01: las paginas HTML
REM  van con Cache-Control: no-store para que el navegador no haga
REM  peticiones condicionales. Sin eso vuelven los 304 pelados que
REM  Safari/iOS convierte en un archivo de 0 KB - la pantalla en
REM  blanco que costo ocho versiones de sw.js encontrar.
REM
REM  El fallo es INVISIBLE en Chrome, en Firefox y en el Mac: solo
REM  rompe en los iPhone. Por eso hace falta comprobarlo a maquina.
REM
REM  Doble clic aqui despues de cada despliegue.
REM ============================================================
cd /d "%~dp0"
python admin\comprobar_cabeceras.py %*
echo.
pause
