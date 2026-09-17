@echo off
REM ============================================================
REM  actualizar_semanal.bat - lo mismo que corre solo una vez
REM  por semana.
REM
REM  Repasa TODOS los chunks de jugadores, refresca los jugadores
REM  ya guardados en Blackjack e Higher or Lower, y sube todo a
REM  Supabase. Tarda mucho mas que actualizar_nocturno.bat (pasa
REM  por ~8.000 jugadores, no solo los activos) - normal que
REM  esto tarde bastante.
REM
REM  El detalle de por que estos pasos y en que orden esta en
REM  admin/tarea_semanal.py.
REM
REM  El resultado tambien queda en admin/logs/ (una semana por
REM  archivo, se guardan las ultimas 14).
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
python admin\tarea_semanal.py
echo.
pause
