/* =============================================
   DEV-SERVER.JS — Servidor local que SÍ ejecuta las funciones de api/
   QUIÉN COÑO FALTA

   `python -m http.server` sirve archivos y punto: una petición a
   /api/titulares le devuelve un 404, así que el ticker de titulares nunca
   se ve funcionando en local (se queda con el texto de reserva). Esto
   imita lo que hace Vercel:

     · /api/<algo>   →  ejecuta api/<algo>.js  (module.exports = handler)
     · cualquier otra ruta → archivo estático, con /ruta/ → /ruta/index.html

   Arrancar con:   node dev-server.js
   Y abrir:        http://localhost:8791

   Solo escucha en 127.0.0.1: es una herramienta de escritorio, no tiene
   por qué estar accesible desde el resto de la red (misma lección que
   editor-server.py).
   ============================================= */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8791;
const ROOT = __dirname;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Nunca salir de ROOT por mucho ../../ que traiga la URL. */
function rutaSegura(pathname) {
  const limpio = decodeURIComponent(pathname).split('?')[0];
  const abs = path.resolve(ROOT, '.' + limpio);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

/* Objeto `res` con la forma que esperan los handlers de Vercel. */
function adaptarRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (obj)  => { res.setHeader('Content-Type', 'application/json; charset=utf-8');
                           res.end(JSON.stringify(obj)); return res; };
  res.send   = (body) => { res.end(body); return res; };
  return res;
}

async function servirApi(req, res, nombre) {
  const archivo = path.join(ROOT, 'api', nombre + '.js');
  if (!fs.existsSync(archivo)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: `api/${nombre}.js no existe` }));
  }
  try {
    // delete require.cache → recarga en caliente al editar la función
    delete require.cache[require.resolve(archivo)];
    const handler = require(archivo);
    const fn = typeof handler === 'function' ? handler : handler.default;
    const t0 = Date.now();
    await fn(req, adaptarRes(res));
    console.log(`  [api] /${nombre} → ${res.statusCode} (${Date.now() - t0} ms)`);
  } catch (e) {
    console.error(`  [api] /${nombre} PETÓ:`, e);
    if (!res.headersSent) res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
}

function servirEstatico(res, abs) {
  let destino = abs;
  if (fs.existsSync(destino) && fs.statSync(destino).isDirectory()) {
    destino = path.join(destino, 'index.html');
  }
  if (!fs.existsSync(destino)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const err404 = path.join(ROOT, '404.html');
    return res.end(fs.existsSync(err404) ? fs.readFileSync(err404) : 'No encontrado');
  }
  res.setHeader('Content-Type', TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream');
  // Sin caché: en desarrollo lo que interesa es ver el cambio, no ahorrar bytes.
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.end(fs.readFileSync(destino));
}

const server = http.createServer((req, res) => {
  // new URL() y no url.parse(): el segundo está deprecado en Node por
  // problemas de seguridad al normalizar rutas.
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);

  const api = pathname.match(/^\/api\/([A-Za-z0-9_-]+)\/?$/);
  if (api) return servirApi(req, res, api[1]);

  const abs = rutaSegura(pathname);
  if (!abs) { res.statusCode = 400; return res.end('ruta invalida'); }
  servirEstatico(res, abs);
});

server.listen(PORT, HOST, () => {
  console.log('='.repeat(58));
  console.log('  FutbolHUB — servidor de desarrollo (con funciones api/)');
  console.log('='.repeat(58));
  console.log(`  Raiz      : ${ROOT}`);
  console.log(`  Escuchando: http://${HOST}:${PORT}   (solo este ordenador)`);
  const funciones = fs.existsSync(path.join(ROOT, 'api'))
    ? fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'))
    : [];
  console.log(`  Funciones : ${funciones.map(f => '/api/' + f.replace(/\.js$/, '')).join(', ') || '(ninguna)'}`);
  console.log('  (Ctrl+C para parar)');
  console.log('='.repeat(58));
});
