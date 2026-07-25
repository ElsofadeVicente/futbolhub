@echo off
REM ============================================================
REM  sync.bat - Sincroniza los JSON locales con Supabase Storage.
REM  Doble clic aqui (o ejecutalo en la terminal) despues de editar
REM  o crear cualquier dato de un juego, y sube a Supabase SOLO lo
REM  que ha cambiado. La web se actualiza sola al terminar.
REM
REM  Tambien puedes pasarle una seccion:  sync.bat crucigrama
REM  o ver que subiria sin subir:          sync.bat --dry-run
REM ============================================================
cd /d "%~dp0"
python admin\sync_supabase.py %*
echo.
pause
