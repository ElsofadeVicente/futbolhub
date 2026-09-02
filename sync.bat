@echo off
REM ============================================================
REM  sync.bat - Los datos de los juegos, a Supabase.
REM  Doble clic aqui despues de editar o crear cualquier dato de
REM  un juego: sube a Supabase SOLO lo que ha cambiado y la web
REM  se actualiza sola al terminar.
REM
REM  Tambien puedes pasarle una seccion:  sync.bat crucigrama
REM  o ver que subiria sin subir:         sync.bat --dry-run
REM
REM  DESDE EL 2026-09-02 HACE UNA COSA MAS: si tocas El
REM  Crucigrama o En el Top, al terminar regenera solo las
REM  paginas de /<juego>/archivo/ (admin/generar_archivo.py).
REM  Iban por separado y olvidarlo no fallaba de ninguna forma
REM  visible: el juego seguia bien y solo se quedaba sin
REM  actualizar el contenido que ve Google.
REM
REM  OJO CON LA DIFERENCIA, que no es la misma cosa:
REM    - los JSON van a Supabase  -> llegan SOLOS a la web
REM    - el archivo son HTML del repo -> necesitan git push
REM
REM  Todo lo demas (comprobaciones, calendario, base de
REM  jugadores) esta en admin.bat.
REM ============================================================
cd /d "%~dp0"
python admin\sync_supabase.py %*
echo.
pause
