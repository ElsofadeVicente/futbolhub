# Nombres de los bots

Los jugadores automáticos de las salas públicas cogen su nombre de
`bot-names.json`: un array JSON con un nombre por línea.

## Dónde vive

**Fuente real:** Supabase Storage, bucket `game-data`, archivo `bot-names.json`
(en la raíz del bucket, no dentro de ninguna carpeta de juego, porque lo usan
blackjack y coche a la vez).

**Respaldo:** la copia de esta carpeta (`data/bot-names.json`), que va en el
repo. Solo se usa si Storage no responde.

## Cómo cambiar los nombres

1. Editar `data/bot-names.json`: añadir o quitar líneas.
2. Subirlo al bucket `game-data` de Supabase Storage sobrescribiendo el
   `bot-names.json` que hay (Storage → game-data → Upload file → confirmar
   el reemplazo).

Con eso ya está: no hay que tocar código ni volver a desplegar. El cambio
lo ven los jugadores en cuanto recargan.

Si además haces commit del archivo, el respaldo del repo queda igual que
Storage. Si no lo haces no pasa nada: solo significa que, en el caso raro de
que Storage falle, se usaría una lista algo más antigua.

## Reglas del archivo

- Array JSON de cadenas: `["nombre uno", "nombre dos"]`.
- También se acepta `{"names": [...]}` por si algún día conviene.
- Los repetidos y los espacios de sobra se limpian solos al cargar, así que no
  pasa nada por dejarlos.
- Si el archivo está vacío o no se puede leer, **no se añaden bots**. Nunca se
  inventa un nombre de relleno.
