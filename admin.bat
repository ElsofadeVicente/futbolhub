@echo off
REM ============================================================
REM  admin.bat - Todo lo que NO es el sync diario, en un menu.
REM
REM  Antes esto eran cinco .bat sueltos en la raiz (calendario,
REM  versiones, cabeceras, actualizar_jugadores y
REM  actualizar_performances_activos). Se juntaron aqui el
REM  2026-09-02 para no tener la raiz llena y para que se vea de
REM  un vistazo que hay y cuando se usa cada cosa.
REM
REM  Los datos de los juegos NO se tocan desde aqui: para eso
REM  esta sync.bat, que ademas regenera solo el archivo de
REM  ediciones.
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"

:menu
cls
echo.
echo   ================================================
echo     FutbolHUB - herramientas
echo   ================================================
echo.
echo     ANTES DE DESPLEGAR
echo       1. Comprobar los ?v= y los hashes de la CSP
echo.
echo     DESPUES DE DESPLEGAR
echo       2. Comprobar las cabeceras en produccion
echo.
echo     CONTENIDO
echo       3. Estado del calendario diario
echo.
echo     BASE DE JUGADORES  (tardan, no hace falta vigilar)
echo       4. Actualizar solo los jugadores en activo
echo       5. Actualizar la base entera (performances + transfers)
echo.
echo       0. Salir
echo.
set "op="
set /p "op=  Elige una opcion: "

if "%op%"=="1" goto versiones
if "%op%"=="2" goto cabeceras
if "%op%"=="3" goto calendario
if "%op%"=="4" goto activos
if "%op%"=="5" goto jugadores
if "%op%"=="0" exit /b 0
goto menu

:versiones
echo.
echo   --- Los ?v= -------------------------------------
echo   Vercel sirve el JS y el CSS con ?v= como inmutables
echo   durante un ano. Si tocas un archivo y no le subes el
echo   ?v=, la gente se queda con el viejo un ano entero.
echo.
python admin\comprobar_versiones.py
echo.
echo   --- Los hashes de la CSP ------------------------
echo   La Carrera lleva CSP de bloqueo: cambiar un espacio
echo   en un script en linea invalida su hash y el navegador
echo   lo bloquea SOLO en produccion.
echo.
python admin\comprobar_csp.py
goto fin

:cabeceras
echo.
echo   Comprueba lo que Vercel esta sirviendo DE VERDAD.
echo   Vigila el no-store de las paginas HTML: sin el vuelven
echo   los 304 pelados que Safari/iOS convierte en un archivo
echo   de 0 KB. Es invisible en Chrome y en el Mac.
echo.
python admin\comprobar_cabeceras.py
goto fin

:calendario
echo.
python admin\estado_calendario.py
goto fin

:activos
echo.
echo   Solo los jugadores con club y valor de mercado ^> 0.
echo   Es el de media temporada: no re-descarga retirados ni
echo   gente sin equipo, que no va a tener partidos nuevos.
echo.
python admin\actualizar_performances_activos.py
goto fin

:jugadores
echo.
echo   La base ENTERA (~8.000 jugadores, dos pasadas).
echo   La usan La Carrera, Coche, Tres en Raya, Bingo y
echo   Superdraft. Tarda bastante.
echo.
python admin\actualizar_jugadores.py
goto fin

:fin
echo.
pause
goto menu
