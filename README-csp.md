# Content-Security-Policy — cómo pasar de "avisar" a "bloquear"

`vercel.json` manda hoy la CSP como **`Content-Security-Policy-Report-Only`**.
Esto es a propósito y no es un descuido.

## Por qué en modo aviso

La web tiene `<script>` en línea y atributos `style=` por todas partes (los
`gtag('consent'…)` de cada cabecera, el HTML que generan los juegos con
`innerHTML`, los `style="--i:N"` de las tarjetas del hub…). Una CSP en modo
bloqueo desde el minuto uno tumbaría media web el mismo día que se despliegue.

En `Report-Only` el navegador **no bloquea nada**: solo escribe en la consola
lo que *habría* bloqueado. Sirve para descubrir qué se dejó fuera de la lista
sin romperle el sitio a nadie.

## De dónde sale la lista de orígenes

De inventariar lo que el código pide de verdad:

| Origen | Para qué | Juego / página |
|---|---|---|
| `fonts.googleapis.com`, `fonts.gstatic.com` | tipografías | todas |
| `www.googletagmanager.com`, `*.google-analytics.com` | GA4 | todas |
| `pagead2.googlesyndication.com`, `*.googlesyndication.com`, `googleads.g.doubleclick.net`, `*.adtrafficquality.google` | AdSense | todas |
| `fundingchoicesmessages.google.com` | CMP de consentimiento | todas |
| `www.gstatic.com` | módulos de Firebase | los 6 juegos online |
| `futbolhub-9d0a4-…firebasedatabase.app` (https + wss) | salas multijugador | los 6 juegos online |
| `rssvejgdekwysiseqzkd.supabase.co` (https + wss) | datos, cuentas, Storage | todas |
| `unpkg.com` | Leaflet 1.9.4 | El Estadio |
| `*.tile.openstreetmap.org` | mapa | El Estadio |
| `www.google.com` (`frame-src`) | iframe de Street View | El Estadio |
| `cdn.jsdelivr.net` | flag-icons | El Mentiroso |

`img-src` va a `https:` a secas y no a una lista: las fotos salen de
Transfermarkt (`tmssl.akamaized.net`, `img.a.transfermarkt.technology`),
`flagcdn.com`, Supabase Storage, los tiles de OSM y los píxeles de AdSense.
Enumerarlos todos se rompería solo. Aun así `img-src https:` sigue cortando
`data:`-URIs con JS y orígenes `http:`, que es de lo que protege.

## Cómo activarla del todo

1. Despliega con `Report-Only` y deja pasar unos días de tráfico real.
2. Abre la consola en **cada** juego (los 13 + portada + privacidad) y anota
   los avisos `Refused to load…` / `Report Only`.
3. Añade a la directiva que toque los orígenes legítimos que falten.
4. Cuando no salga nada durante una semana, en `vercel.json` cambia la clave

   ```
   "Content-Security-Policy-Report-Only"   →   "Content-Security-Policy"
   ```

No pasa nada por tardar. Report-Only ya sirve de sistema de alarma: si algún
día apareciera un script inyectado desde un origen que no está en la lista,
saldría en la consola aunque no se esté bloqueando todavía.

## Lo que ya bloquea de verdad (no depende de la CSP)

`vercel.json` manda también, en modo normal:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
