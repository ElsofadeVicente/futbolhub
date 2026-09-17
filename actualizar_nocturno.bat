@echo off
REM ============================================================
REM  actualizar_nocturno.bat - lo mismo que corre solo a las 3am.
REM
REM  Encadena: performances de jugadores en activo -> recalcular
REM  perf_stats.json/gen_pool*.json -> subir a Supabase. Todo el
REM  detalle (por que estos tres pasos y en este orden) esta en
REM  admin/tarea_nocturna.py.
REM
REM  Doble clic aqui hace EXACTAMENTE lo mismo que hace la tarea
REM  programada de madrugada - util para probarlo o para lanzarlo
REM  a mano un dia cualquiera sin esperar a la noche.
REM
REM  El resultado tambien queda en admin/logs/ (una noche por
REM  archivo, se guardan las ultimas 14).
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"
python admin\tarea_nocturna.py
echo.
pause
