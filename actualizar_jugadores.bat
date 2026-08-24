@echo off
REM ============================================================
REM  actualizar_jugadores.bat - Refresca TODA la base de
REM  performances y transfers (data/performances, data/transfers),
REM  no solo los jugadores de un juego concreto: la usan La Carrera,
REM  Coche, Tres en Raya, Bingo y Superdraft, y si no se refresca se
REM  queda obsoleta para todos a la vez (partidos nuevos, fichajes,
REM  cambios de club...).
REM
REM  Doble clic aqui y ya esta: la logica vive en
REM  admin/actualizar_jugadores.py (--full en los dos scripts, con
REM  el progreso de cada uno en vivo). Tarda bastante, no hace falta
REM  vigilarlo.
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
python admin\actualizar_jugadores.py
echo.
pause
