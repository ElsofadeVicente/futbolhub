/* ═══════════════════════════════════════════════════════════════
   EL CRUCIGRAMA — 190 niveles repartidos en 10 divisiones
   ═══════════════════════════════════════════════════════════════

   Hasta 2026-09-09 esto era un juego DIARIO: un crucigrama por fecha,
   calendario de meses en Storage, navegación por ediciones y racha en el
   hub. Ya no. Ahora es una carrera de 190 niveles y el banco entero de
   1.900 palabras se reparte entre ellos, cada una en un único nivel.

   Lo que eso cambia:
     · Los datos son 10 archivos, uno por división (~31 KB), y solo se baja
       la división que se juega.
     · No hay progreso a medias: al entrar en un nivel la rejilla está
       SIEMPRE vacía, también si ya lo tenías con estrellas. Para mejorar la
       marca hay que volver a hacerlo entero.
     · Lo único que se guarda es cuántas estrellas tiene cada nivel
       (crucniv_<n>), y nunca baja.
   ═══════════════════════════════════════════════════════════════ */

/* ── Las divisiones ──
   `entrada` = estrellas que hacen falta EN LA DIVISIÓN ANTERIOR para pasar a
   esta. Cada división da 60 (20 niveles x 3), así que 30 es la mitad: los 20
   niveles pasados raspando dan 20, o sea que la puerta obliga a volver a por
   algunos. Sube hasta 45 en las últimas, donde ya sabes jugar. */
const CRUC_DIVISIONES = [
    { nombre: 'Fútbol Base',       niveles: 20, entrada: 0  },
    { nombre: 'Tercera División',  niveles: 20, entrada: 30 },
    { nombre: 'Segunda B',         niveles: 20, entrada: 32 },
    { nombre: 'Segunda División',  niveles: 20, entrada: 34 },
    { nombre: 'Primera División',  niveles: 20, entrada: 36 },
    { nombre: 'Conference League', niveles: 20, entrada: 38 },
    { nombre: 'Europa League',     niveles: 20, entrada: 40 },
    { nombre: 'Champions League',  niveles: 20, entrada: 42 },
    { nombre: 'Mundial',           niveles: 20, entrada: 44 },
    { nombre: 'Leyenda',           niveles: 10, entrada: 45 }
];
const CRUC_TOTAL_NIVELES = CRUC_DIVISIONES.reduce((s, d) => s + d.niveles, 0);
const CRUC_PALABRAS_NIVEL = 10;

// ── Estado ───────────────────────────────────
let crucData        = null;   // el nivel que se está jugando
let crucNivel       = 0;      // su número, 1..190
let crucCells       = null;   // Set de "r,c" jugables
let crucSegundos    = 0;
let crucRelojTimer  = null;
let crucMalas       = new Set();
let crucUserGrid    = {};
let crucSolvedWords = new Set();
let crucSelectedWord = null;
let crucSelectedCell = null;
let crucHidden      = false;
let crucArranqueIncompleto = false;
let crucReintentando       = false;
const crucDivCache  = {};     // nº de división -> [niveles]

/* Cuando se vuelve al mapa tras SUPERAR un nivel, se guarda aquí para que el
   mapa lo celebre (el nodo se vuelve oro, las estrellas saltan, y si la
   partida abrió una división nueva sale el cartel de ascenso). Se CONSUME al
   celebrarlo — crucPintarMapa lo lee una vez y lo pone a null. */
let crucCelebrar  = null;
let crucContando  = false;    // el contador de estrellas está en pleno recuento

/* Un solo sitio para saber si hay que quitar las animaciones. */
function crucSuave() {
    return !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function goToHub() { window.location.href = '../'; }

// ── Progreso: solo las estrellas de cada nivel ───────────────
function crucEstrellas(n) {
    const v = parseInt(localStorage.getItem(`crucniv_${n}`), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 0;
}
function crucApuntarEstrellas(n, est) {
    /* Nunca baja: repetir un nivel solo puede mejorarlo. */
    if (est <= crucEstrellas(n)) return false;
    try { localStorage.setItem(`crucniv_${n}`, String(est)); } catch {}
    if (window.FHProgress && FHProgress.push) FHProgress.push();
    return true;
}
function crucEstrellasDe(aciertos) {
    const fallos = CRUC_PALABRAS_NIVEL - aciertos;
    if (fallos === 0) return 3;
    if (fallos === 1) return 2;
    if (fallos === 2) return 1;
    return 0;                      // tres o más sin acertar: no se pasa
}
function crucPrimeroDe(idx) {
    return CRUC_DIVISIONES.slice(0, idx).reduce((s, d) => s + d.niveles, 0) + 1;
}
function crucDivisionDe(nivel) {
    let acc = 0;
    for (let i = 0; i < CRUC_DIVISIONES.length; i++) {
        if (nivel <= acc + CRUC_DIVISIONES[i].niveles) {
            return { idx: i, primero: acc + 1, ...CRUC_DIVISIONES[i] };
        }
        acc += CRUC_DIVISIONES[i].niveles;
    }
    const u = CRUC_DIVISIONES.length - 1;
    return { idx: u, primero: acc - CRUC_DIVISIONES[u].niveles + 1, ...CRUC_DIVISIONES[u] };
}
function crucEstrellasDivision(idx) {
    const p = crucPrimeroDe(idx);
    let t = 0;
    for (let n = p; n < p + CRUC_DIVISIONES[idx].niveles; n++) t += crucEstrellas(n);
    return t;
}
function crucDivisionAbierta(idx) {
    return idx === 0 || crucEstrellasDivision(idx - 1) >= CRUC_DIVISIONES[idx].entrada;
}
function crucEstrellasTotales() {
    let t = 0;
    for (let n = 1; n <= CRUC_TOTAL_NIVELES; n++) t += crucEstrellas(n);
    return t;
}
/* Los niveles van EN ORDEN de principio a fin: para abrir el n hace falta el
   n-1 hecho (con al menos una estrella), no basta con ser el primero de una
   división. Sólo el 1 arranca abierto. Encima está la puerta de división
   (estrellas de entrada), que puede tener cerrada la división aunque el n-1
   esté hecho — así que se piden las dos cosas. */
function crucNivelAbierto(n) {
    const d = crucDivisionDe(n);
    if (!crucDivisionAbierta(d.idx)) return false;
    return n === 1 || crucEstrellas(n - 1) > 0;
}
/* Dónde está el jugador: el primer nivel abierto sin estrellas. Si ya tiene
   todos los abiertos y la puerta siguiente está cerrada, el último abierto. */
function crucNivelActual() {
    let ultimo = 1;
    for (let n = 1; n <= CRUC_TOTAL_NIVELES; n++) {
        if (!crucNivelAbierto(n)) continue;
        ultimo = n;
        if (crucEstrellas(n) === 0) return n;
    }
    return ultimo;
}

// ── Reloj y comprobar (se conservan del juego diario) ────────
function crucFormatoTiempo(seg) {
    const m = Math.floor(seg / 60), s = seg % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}
function crucRelojArranca() {
    crucRelojPara();
    if (crucIsComplete()) return;
    crucRelojTimer = setInterval(() => {
        if (document.hidden) return;
        crucSegundos++;
        const el = document.getElementById('cruc-reloj');
        if (el) el.textContent = crucFormatoTiempo(crucSegundos);
    }, 1000);
}
function crucRelojPara() {
    if (crucRelojTimer) { clearInterval(crucRelojTimer); crucRelojTimer = null; }
}

/* Ya no se guarda la partida a medias: al entrar en un nivel la rejilla
   está vacía SIEMPRE, que es la regla del modo por niveles. Se deja la
   función porque el motor la llama en cinco sitios y así no hay que ir
   quitando llamadas de dentro del teclado. */
function crucSave() {}

/* FINALIZAR: cierra el nivel con las palabras que llevas. Sustituye a
   Comprobar y a Revelar — no se revela nada. Sirve para acabar con una o dos
   estrellas sin resolverlo entero: fallar una palabra da 2 estrellas y fallar
   dos da 1, y en ambos casos SE PASA al siguiente nivel. El aviso lo dice
   antes de cerrar. */
function crucFinalizar() {
    if (!crucData || crucIsComplete()) return;
    /* Sin diálogo: finaliza directo. El aviso permanente de la barra ya dice
       que puedes acabar a falta de una o dos, y el resultado se ve en el modal. */
    crucRelojPara();
    crucShowCompletion(false);
}

/* ── DONDE VIVE EL TEXTO DE LA PAGINA ──────────────────────────────────
   `.cruc-info` (la descripcion + los enlaces a otros juegos) es contenido de
   la pagina y tiene que poder LEERSE, no solo estar en el HTML. Como en el
   mapa la pagina no scrollea, ahi se mete al final del scroll DEL MAPA: bajas
   pasado el nivel 1 y lo encuentras, con una sola barra y sin que el campo
   deje de llenar la ventana. En la pantalla de un nivel vuelve a su sitio,
   debajo de la rejilla, que es donde scrollea la pagina.

   Se guarda la REFERENCIA al nodo: `crucPintarMapa` reemplaza el innerHTML de
   la pantalla entera, asi que si estaba dentro se queda fuera del documento y
   un querySelector ya no lo encuentra nunca mas. Es lo mismo que le pasa al
   circulo de perfil en js/cabecera.js. */
let crucInfo = null;
function crucInfoNodo() {
    if (!crucInfo || !crucInfo.nodeType) crucInfo = document.querySelector('.cruc-info');
    return crucInfo;
}
function crucInfoAlCuerpo() {
    const info = crucInfoNodo(), pantalla = document.getElementById('crucigrama-screen');
    if (!info || !pantalla || !pantalla.parentNode) return;
    if (info.parentNode !== pantalla.parentNode) {
        pantalla.parentNode.insertBefore(info, pantalla.nextSibling);
    }
    info.classList.remove('cruc-info--en-mapa');
}
function crucInfoAlMapa(wrap) {
    const info = crucInfoNodo();
    if (!info || !wrap) return;
    info.classList.add('cruc-info--en-mapa');
    wrap.appendChild(info);
}

/* Fija la pagina al mapa (ver el comentario de .cruc-mapa-fija en el CSS).
   Se apaga en CUALQUIER otra pantalla: la rejilla de un nivel, la espera y el
   error necesitan poder desplazarse. */
function crucPaginaFija(si) {
    document.documentElement.classList.toggle('cruc-mapa-fija', !!si);
}

// ── Pantallas de espera y error ──────────────
function crucLoading(msg) {
    const screen = document.getElementById('crucigrama-screen');
    if (!screen) return;
    crucPaginaFija(false);
    crucInfoAlCuerpo();
    screen.innerHTML = `
        <button class="fh-volver" onclick="goToHub()">← Volver</button>
        <div class="cruc-espera"><div class="cruc-espera-txt">${crucEsc(msg)}</div></div>`;
}
function crucFatal(texto) {
    const screen = document.getElementById('crucigrama-screen');
    if (!screen) return;
    crucPaginaFija(false);
    crucInfoAlCuerpo();
    screen.innerHTML = `
        <button class="fh-volver" onclick="goToHub()">← Volver</button>
        <div class="cruc-espera">
            <div class="cruc-espera-tit">CRUCIGRAMA NO DISPONIBLE</div>
            <div class="cruc-espera-txt">${crucEsc(texto)}</div>
        </div>`;
}

// ── Datos: una división por archivo ──────────
async function crucCargarDivision(idx) {
    if (crucDivCache[idx]) return crucDivCache[idx];
    const ruta = `crucigrama/niveles/${String(idx + 1).padStart(2, '0')}.json`;
    const url = sbStorageUrl('game-data', ruta);
    /* Con reintento y espera de red (js/red.js): el momento en que esto se
       caía era volver a la app tras tenerla en segundo plano, con iOS aún
       levantando la conexión. */
    const j = window.FHRed
        ? await FHRed.json(url)
        : await (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('división no disponible');
            return res.json();
        })();
    crucDivCache[idx] = j.niveles || [];
    return crucDivCache[idx];
}

/* ══════════════════ EL MAPA ══════════════════
   Diez campos apilados, uno por división, separados por la banda que anuncia
   la siguiente. Dentro de cada campo el recorrido va de una portería a la
   otra: el primer nivel de la división cae en un área y el último en la
   contraria — eso manda sobre todo lo demás y de ahí sale el alto del campo. */
const CRUC_PASO_BASE = 88, CRUC_ANCHO_BASE = 375;

/* En un ordenador el mapa no se queda en una columna estrecha: coge hasta
   1.000 px, o sea todo el hueco entre las dos columnas de anuncio. Pero
   ensanchar SOLO el campo lo achata -los niveles se separan a lo ancho y el
   recorrido pierde la forma-, así que lo que sube con el ancho es TODO: la
   altura por nivel, el nodo, las estrellas y el grosor del trazo. El
   resultado es el mismo mapa, más grande.

   El tope de 2,70 es el ancho máximo (1.000) partido por el de móvil (375):
   está para que un monitor enorme no siga escalando cuando el campo ya no
   crece, no para recortar el escritorio normal. */
/* EL CAMPO Y EL PASILLO SON DOS ANCHOS DISTINTOS, y esto es la clave del
   aspecto en escritorio. Escalarlo todo con el ancho del campo dejaba el mapa
   con aire de zoom x10: nodos de 88 px y solo cuatro niveles en pantalla.

   Ahora el CAMPO se estira a lo ancho todo lo que dé el hueco -y ese sobrante
   es fuera de banda, que es lo que hace que parezca un campo enorme- mientras
   el RECORRIDO se queda en un pasillo central de 560 px como mucho. Lo que
   crece con el ancho es el césped; los niveles, el trazo y las fotos se
   escalan con el pasillo, o sea muy poco. */
const CRUC_PASILLO_MAX = 560;
function crucPasillo(ancho) { return Math.min(ancho, CRUC_PASILLO_MAX); }
function crucEscala(ancho) {
    return Math.max(1, Math.min(1.50, crucPasillo(ancho) / CRUC_ANCHO_BASE));
}
/* El paso vertical NO crece a la misma escala que el ancho: con la escala
   completa, en un campo ancho solo entraban cuatro niveles por pantalla.
   A 0,35 del camino se ven seis, que es lo que se quiere ver. */
function crucPaso(ancho) {
    return Math.round(CRUC_PASO_BASE * (1 + (crucEscala(ancho) - 1) * 0.35));
}
function crucBanda(ancho) { return Math.round(104 * (1 + (crucEscala(ancho) - 1) * 0.5)); }

function crucCentroArea(ancho) { return 14 + (0.243 * ancho * 1.60) / 2; }
function crucAltoCampo(niveles, ancho) {
    return Math.round(2 * crucCentroArea(ancho) + (niveles - 1) * crucPaso(ancho));
}
function crucRnd(i, sal) {
    const x = Math.sin(i * 127.1 + sal * 311.7) * 43758.5453;
    return x - Math.floor(x);
}

/* Los niveles NO van sobre una onda regular: van a un lado y a otro con
   amplitud y separación variables, y a veces DOS quedan a la misma altura,
   uno a cada banda. Como mucho dos: con tres seguidos, el primero y el
   tercero acaban pisándose por mucho que alternen de lado. */
function crucPosiciones(n, ancho, alto, sal) {
    const cA = crucCentroArea(ancho);
    const yIni = alto - cA, yFin = cA;
    const paso = crucPaso(ancho);
    /* Las x se calculan DENTRO DEL PASILLO y luego se llevan a su sitio: lo
       que sobra a los lados es banda, y ahí no entra ningún nivel. */
    const P = crucPasillo(ancho), dx = (ancho - P) / 2;
    const pesos = [];
    let anteriorPlano = false;
    for (let i = 0; i < n - 1; i++) {
        const plano = !anteriorPlano && crucRnd(i, sal) < 0.26;
        pesos.push(plano ? 0.10 + crucRnd(i + 3, sal) * 0.12
                         : 0.78 + crucRnd(i + 5, sal) * 0.55);
        anteriorPlano = plano;
    }
    const escala = (yIni - yFin) / pesos.reduce((a, b) => a + b, 0);

    const pts = [];
    let y = yIni, lado = crucRnd(99, sal) < 0.5 ? 1 : -1, seguidos = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0) y -= pesos[i - 1] * escala;
        if (i === n - 1) y = yFin;
        let x;
        if (i === 0 || i === n - 1) {
            x = P / 2 + (crucRnd(i + 11, sal) - 0.5) * P * 0.12;   // frente a portería
        } else if (pesos[i - 1] * escala < paso * 0.52) {
            lado = -lado; seguidos = 0;
            x = P / 2 + lado * (0.27 + crucRnd(i + 17, sal) * 0.07) * P;
        } else {
            if (seguidos >= (crucRnd(i + 90, sal) < 0.30 ? 2 : 1)) { lado = -lado; seguidos = 0; }
            else seguidos++;
            x = P / 2 + lado * (0.14 + crucRnd(i, sal) * 0.20) * P;
        }
        for (let k = pts.length - 1; k >= 0; k--) {
            const q = pts[k];
            if (Math.abs(q.y - y) > paso * 0.89) break;
            if (Math.abs(q.x - (x + dx)) < 96 * crucEscala(ancho)) {
                x = P / 2 - Math.sign(q.x - dx - P / 2 || 1) * 0.29 * P;
            }
        }
        pts.push({ x: x + dx, y });
    }
    /* Niveles 187, 188, 189 y 190 (Leyenda, sal===10 -que es idxDiv+1- es la
       única división de 10 niveles) curados a mano: el 188 y el 189 van al
       lado IZQUIERDO para dejar libre el derecho del área de arriba, que es
       donde va la tarjeta de Iniesta (nivel 190, curada en tarjetas.json con
       x≈0.81); el 187 se reparte a partes iguales entre el 186 y el 188 en
       vez de dejarlo con la Y al azar -con la original, el 187 caía pegado
       al 188 (59px) y con un hueco enorme hasta el 186 (146px), apretado por
       un lado y suelto por el otro-; y el 190 se fija centrado.
       El 190 YA debía caer centrado sin tocar nada -es el ÚLTIMO nivel de la
       división, y la rama "frente a portería" de más arriba ya lo fuerza al
       centro para cualquier división-, pero en esta división concreta el
       aviso de solape de más arriba lo desviaba: al colocarlo detectaba el
       189 SIN curar demasiado cerca y lo empujaba fuera del centro -medido:
       acababa a un 21% del pasillo, no al 50%-.
       Los cuatro se fijan DESPUÉS del bucle entero, no dentro: cambiar uno
       sin tocar los demás dentro del bucle vuelve a chocar con ese mismo
       aviso de solape (justo lo que causaba los dos problemas de arriba) y
       lo devuelve a una posición que no se quiere. Aquí ya no hace falta
       pasar por ese aviso: la Y de 187, 188 y 189 se reparte en CUATRO
       tramos iguales entre el 186 (pts[5], intacto) y el 190 (yFin, el
       centro del área), así que el hueco entre cada dos queda garantizado
       por construcción, sin depender de dónde cayera nada al azar. El
       rodeo automático de crucRecorrido se adapta solo a las posiciones
       nuevas. */
    if (sal === 10 && n === 10) {
        const y5 = pts[5].y, tramo = (y5 - yFin) / 4;
        pts[6] = { x: pts[6].x,       y: y5 - tramo * 1 };   // nivel 187
        pts[7] = { x: dx + P * 0.30,  y: y5 - tramo * 2 };   // nivel 188
        pts[8] = { x: dx + P * 0.17,  y: y5 - tramo * 3 };   // nivel 189
        pts[9] = { x: dx + P / 2,     y: yFin };              // nivel 190
    }
    return pts;
}

/* Cada tramo entre dos niveles es un ARCO que se abomba hacia fuera, y el
   abombamiento alterna de lado: de ahí el rodeo. Una onda continua, por
   mucha amplitud que se le ponga, no da esa sensación.

   PERO alternar a ciegas hace que dos tramos se crucen: pasa cuando hay
   niveles a la misma altura y el arco se abomba justo hacia donde viene el
   siguiente. Así que no se elige el abombamiento a ojo: se prueban las
   opciones (los dos lados, de más curvo a más recto) y se coge la primera
   que no corte ningún tramo anterior ni pase por encima de un nivel ajeno. */
/* `f` abomba el arco perpendicular a la cuerda y `g` corre el punto de
   control A LO LARGO de ella. Ese segundo mando parecía un adorno y no lo es:
   con solo el abombamiento hay tramos —dos de los 190— donde NINGUNA opción
   queda limpia y había que quedarse con el menos malo, o sea con un cruce. */
function crucPuntoControl(a, b, signo, f, g) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const curva = len * f * signo, corre = len * (g || 0);
    return { x: (a.x + b.x) / 2 - (dy / len) * curva + (dx / len) * corre,
             y: (a.y + b.y) / 2 + (dx / len) * curva + (dy / len) * corre };
}
/* 22 muestras, no 14. Con 14 se colaban cruces poco profundos: el corte
   ocurría dentro de un tramo recto y la comprobación no lo veía. Lo que hace
   que 22 no cueste tiempo es la caja de más abajo. */
const CRUC_MUESTRAS = 44;
function crucMuestrasArco(a, c, b, n) {
    const out = [];
    for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
                   y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
    return out;
}
/* Caja envolvente: dos tramos que no se solapan ni siquiera de lejos no
   pueden cortarse, y en un campo de 19 tramos la mayoría de parejas están a
   media pantalla. Descartarlas de un vistazo es lo que permite subir las
   muestras y el número de opciones sin que la carga se note. */
function crucCaja(m) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of m) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
}
function crucCajasLejos(c1, c2) {
    return c1.x1 < c2.x0 || c2.x1 < c1.x0 || c1.y1 < c2.y0 || c2.y1 < c1.y0;
}
function crucSeCortan(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

/* Devuelve los arcos ya resueltos: el path para dibujar y las muestras, que
   sirven también para colocar las fotos sin pisar la línea. */
function crucRecorrido(pts, sal, ancho) {
    /* Las opciones de cada tramo, de la más curva a la más recta y probando
       los dos lados. `g` (correr el control por la cuerda) va después de `f`
       en el orden a propósito: primero se busca el rodeo simétrico, que es el
       que se ve bien, y solo si ninguno vale se recurre al asimétrico. */
    const opcionesDe = (i) => {
        const base = (i % 2 === 0 ? 1 : -1) * (crucRnd(i + 7, sal) < 0.22 ? -1 : 1);
        const rizo = 0.28 + crucRnd(i + 13, sal) * 0.20;
        const ops = [];
        for (const g of [0, 0.22, -0.22, 0.42, -0.42]) {
            for (const signo of [base, -base]) {
                for (const f of [rizo * 1.25, rizo, rizo * 0.66, rizo * 0.4, rizo * 0.2, 0]) {
                    ops.push({ signo, f, g });
                }
            }
        }
        return ops;
    };
    /* Dos tramos PEGADOS no se cruzan limpiamente: se ROZAN. Donde el
       recorrido dobla hacia atrás —hay giros de 105° a 155° entre niveles— el
       arco que sale del nodo se pega al que llegaba y se solapan en una uña
       finísima. Preguntar "¿se cortan?" ahí es una lotería del muestreo: con
       22 muestras salían 3 cruces, con 44 salían 6, y con 140 más. La
       pregunta buena no es si se cortan sino CUÁNTO SE ACERCAN, que no
       depende de la resolución.

       Cerca del nodo compartido se tocan por definición, así que ese entorno
       (el propio disco del nivel, que además lo tapa) no cuenta. */
    /* El radio de exclusión es EL DEL NODO, y el nodo crece con el mapa
       (--cruc-n en el CSS): 26 px en un móvil y 44 en un escritorio ancho.
       Dejarlo fijo en 44 tapaba de más en móvil y escondía un cruce real. */
    const NODO_R = 26 * (1 + (crucEscala(ancho || CRUC_ANCHO_BASE) - 1) * 0.42);
    const ROCE = 12;
    const chocan = (mA, mB, seguidos, nodo) => {
        if (seguidos !== 0 && nodo) {
            for (const p of mA) {
                if (Math.hypot(p.x - nodo.x, p.y - nodo.y) < NODO_R) continue;
                for (const q of mB) {
                    if (Math.hypot(q.x - nodo.x, q.y - nodo.y) < NODO_R) continue;
                    if (Math.hypot(p.x - q.x, p.y - q.y) < ROCE) return true;
                }
            }
            return false;
        }
        for (let x = 0; x < mA.length - 1; x++) {
            for (let y = 0; y < mB.length - 1; y++) {
                if (crucSeCortan(mA[x], mA[x + 1], mB[y], mB[y + 1])) return true;
            }
        }
        return false;
    };
    const vecino = (i, j) => (j === i + 1 ? 1 : j === i - 1 ? -1 : 0);
    const evaluar = (i, op, arcos, hasta) => {
        const c = crucPuntoControl(pts[i], pts[i + 1], op.signo, op.f, op.g);
        const m = crucMuestrasArco(pts[i], c, pts[i + 1], CRUC_MUESTRAS);
        const caja = crucCaja(m);
        let coste = 0;
        for (let j = 0; j < hasta; j++) {
            if (j === i || !arcos[j]) continue;
            if (crucCajasLejos(caja, arcos[j].caja)) continue;
            const v = vecino(i, j);
            if (chocan(m, arcos[j].muestras, v, v === 1 ? pts[i + 1] : v === -1 ? pts[i] : null)) coste++;
        }
        /* Y que no pase por encima de un nivel que no sea de este tramo. */
        for (let k = 0; k < pts.length; k++) {
            if (k === i || k === i + 1) continue;
            if (pts[k].x < caja.x0 - 36 || pts[k].x > caja.x1 + 36) continue;
            if (pts[k].y < caja.y0 - 36 || pts[k].y > caja.y1 + 36) continue;
            if (m.some(q => Math.hypot(q.x - pts[k].x, q.y - pts[k].y) < 36)) { coste += 3; break; }
        }
        return { c, muestras: m, caja, coste };
    };
    const mejorDe = (i, arcos, hasta) => {
        let mejor = null;
        for (const op of opcionesDe(i)) {
            const cand = evaluar(i, op, arcos, hasta);
            if (!mejor || cand.coste < mejor.coste) mejor = cand;
            if (mejor.coste === 0) break;
        }
        return mejor;
    };

    const arcos = [];
    for (let i = 0; i < pts.length - 1; i++) arcos.push(mejorDe(i, arcos, i));

    /* Segunda pasada. En la primera, cada tramo solo puede mirar a los que ya
       están puestos, así que un cruce con uno POSTERIOR no se ve venir. Aquí
       ya están todos: se rehace el que cruce, mirando a los dos lados. Se
       repite hasta que no queda ninguno sucio (tres vueltas como mucho: si en
       tres no ha convergido, es que no va a converger). */
    for (let vuelta = 0; vuelta < 3; vuelta++) {
        let quedan = 0;
        for (let i = 0; i < arcos.length; i++) {
            const sucio = arcos.some((otro, j) => {
                if (j === i || crucCajasLejos(arcos[i].caja, otro.caja)) return false;
                const v = vecino(i, j);
                return chocan(arcos[i].muestras, otro.muestras, v,
                              v === 1 ? pts[i + 1] : v === -1 ? pts[i] : null);
            });
            if (!sucio) continue;
            arcos[i] = mejorDe(i, arcos, arcos.length);
            if (arcos[i].coste > 0) quedan++;
        }
        if (!quedan) break;
    }

    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    arcos.forEach((arco, i) => {
        const b = pts[i + 1];
        d += ` Q ${arco.c.x.toFixed(1)} ${arco.c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    });
    return { d, muestras: arcos.flatMap(a => a.muestras) };
}

/* El campo: mucho más ancho que la pantalla, así que solo se ve su franja
   central y el área entra y se corta por los lados. Medidas reglamentarias
   en proporción (68 x 105 m) tomadas del ANCHO, no del alto. */
function crucDibujoCampo(W, H) {
    const CW = W * 1.60, X0 = (W - CW) / 2;
    const cx = W / 2, cy = H / 2, m = 14;
    const aG = { w: 0.593 * CW, h: 0.243 * CW };
    const aP = { w: 0.269 * CW, h: 0.089 * CW };
    const rC = 0.134 * CW, penal = 0.162 * CW;
    const port = { w: 0.108 * CW, h: 0.026 * CW };
    const red = (y, arriba) => {
        const x1 = cx - port.w / 2, y0 = arriba ? y - port.h : y;
        let b = '';
        for (let i = 1; i < 6; i++) {
            const x = x1 + port.w * i / 6;
            b += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + port.h}"/>`;
        }
        return `<rect x="${x1}" y="${y0}" width="${port.w}" height="${port.h}"/>${b}`;
    };
    return `<svg class="cruc-lineas" viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <g fill="none" stroke="var(--cruc-cal)" stroke-width="3" stroke-linejoin="round">
          <line x1="${X0}" y1="${m}" x2="${X0 + CW}" y2="${m}"/>
          <line x1="${X0}" y1="${H - m}" x2="${X0 + CW}" y2="${H - m}"/>
          <line x1="${X0}" y1="${cy}" x2="${X0 + CW}" y2="${cy}"/>
          <circle cx="${cx}" cy="${cy}" r="${rC}"/>
          <circle cx="${cx}" cy="${cy}" r="4" fill="var(--cruc-cal)" stroke="none"/>
          <rect x="${cx - aG.w / 2}" y="${m}" width="${aG.w}" height="${aG.h}"/>
          <rect x="${cx - aP.w / 2}" y="${m}" width="${aP.w}" height="${aP.h}"/>
          <circle cx="${cx}" cy="${m + penal}" r="3.5" fill="var(--cruc-cal)" stroke="none"/>
          <path d="M ${cx - rC * 0.8} ${m + aG.h} A ${rC} ${rC} 0 0 0 ${cx + rC * 0.8} ${m + aG.h}"/>
          ${red(m, true)}
          <rect x="${cx - aG.w / 2}" y="${H - m - aG.h}" width="${aG.w}" height="${aG.h}"/>
          <rect x="${cx - aP.w / 2}" y="${H - m - aP.h}" width="${aP.w}" height="${aP.h}"/>
          <circle cx="${cx}" cy="${H - m - penal}" r="3.5" fill="var(--cruc-cal)" stroke="none"/>
          <path d="M ${cx - rC * 0.8} ${H - m - aG.h} A ${rC} ${rC} 0 0 1 ${cx + rC * 0.8} ${H - m - aG.h}"/>
          ${red(H - m, false)}
        </g></svg>`;
}

function crucEstrellaSVG(llena) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.4l2.95 6.0 6.6.96-4.78 4.66 1.13 6.58L12 17.45 6.1 20.6l1.13-6.58L2.45 9.36l6.6-.96z"
        fill="${llena ? 'var(--cruc-oro)' : 'var(--cruc-oro-off)'}"
        stroke="${llena ? 'var(--cruc-oro-bd)' : 'var(--cruc-oro-off-bd)'}"
        stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
function crucFilaEstrellas(n) {
    let h = '';
    for (let i = 0; i < 3; i++) h += crucEstrellaSVG(i < n);
    return h;
}
function crucCandado() {
    return `<svg class="cruc-candado" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10V7a5 5 0 0110 0v3" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2.4"/>
      <rect x="4" y="10" width="16" height="11" rx="2" fill="rgba(255,255,255,.55)"/></svg>`;
}

/* ── EFECTOS REUTILIZABLES (chispas, confeti, anillo) ─────────────────────
   Se generan por JS y no en el marcado porque necesitan direcciones al azar y
   se limpian solos. Cada uno se autodestruye al terminar la animación, así que
   no dejan basura en el DOM ni sobreviven a un repintado del mapa. Todos
   comprueban crucSuave(): con "reduzca el movimiento" no se dibuja nada. */
function crucChispas(host, n, oro) {
    if (!host || crucSuave()) return;
    const capa = document.createElement('div');
    capa.className = 'cruc-chispas';
    for (let i = 0; i < n; i++) {
        const s = document.createElement('i');
        s.className = 'cruc-chispa';
        const ang = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.7;
        const dist = 34 + Math.random() * 52;
        s.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        s.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
        s.style.setProperty('--d', (Math.random() * 0.12).toFixed(3) + 's');
        if (!oro) s.style.background = ['#e0a326', '#4f7d3a', '#b5221e', '#f4ead2'][i % 4];
        capa.appendChild(s);
    }
    host.appendChild(capa);
    setTimeout(() => capa.remove(), 1400);
}


/* ══════════ LO QUE LLENA LOS HUECOS DEL CAMPO ══════════
   Dos piezas: la foto icónica y el recorte de prensa. El recorte no es
   adorno: api/titulares.js ya trae titulares reales de Marca, AS, Mundo
   Deportivo y Sport para el ticker de la portada, así que puede alimentar
   esto sin datos nuevos. Las fotos habría que curarlas a mano. */
const CRUC_ICONOS = {
    balon: `<svg viewBox="0 0 24 24" fill="none" stroke="#e8e4d6" stroke-width="1.5">
      <circle cx="12" cy="12" r="9"/><path d="M12 7l3.5 2.5-1.3 4.2h-4.4L8.5 9.5z"/>
      <path d="M12 3v4M4.2 9.6l4.3-.1M19.8 9.6l-4.3-.1M7.2 20l2.6-6M16.8 20l-2.6-6"/></svg>`,
    copa: `<svg viewBox="0 0 24 24" fill="none" stroke="#e8e4d6" stroke-width="1.5">
      <path d="M7 3h10v5a5 5 0 01-10 0z"/><path d="M7 5H4v2a3 3 0 003 3M17 5h3v2a3 3 0 01-3 3"/>
      <path d="M12 13v4M9 21h6M10 17h4l.6 4h-5.2z"/></svg>`,
    estadio: `<svg viewBox="0 0 24 24" fill="none" stroke="#e8e4d6" stroke-width="1.5">
      <ellipse cx="12" cy="12" rx="9" ry="6"/><ellipse cx="12" cy="12" rx="4.5" ry="3"/>
      <path d="M3 12v3c0 3.3 4 6 9 6s9-2.7 9-6v-3"/></svg>`,
    bota: `<svg viewBox="0 0 24 24" fill="none" stroke="#e8e4d6" stroke-width="1.5">
      <path d="M3 9h6l6 3h5a2 2 0 012 2v3H4a1 1 0 01-1-1z"/><path d="M6 17v2M11 17v2M16 17v2"/></svg>`
};
const CRUC_HITOS = [
    { tipo: 'foto',    icono: 'copa',    pie: 'La Décima · Lisboa, 2014' },
    { tipo: 'recorte', medio: 'Marca',   tit: 'Iniesta de mi vida',
      pie: "El gol del 116' que dio el Mundial" },
    { tipo: 'foto',    icono: 'balon',   pie: 'La Mano de Dios · México 86' },
    { tipo: 'recorte', medio: 'Sport',   tit: '6-1: la noche del Camp Nou',
      pie: 'La remontada al PSG, marzo de 2017' },
    { tipo: 'foto',    icono: 'estadio', pie: 'Maracanazo · Río, 1950' },
    { tipo: 'recorte', medio: 'As',      tit: 'Volea de Zidane en Glasgow',
      pie: 'La Novena, mayo de 2002' },
    { tipo: 'foto',    icono: 'bota',    pie: 'El Camp Nou de Ronaldinho' },
    { tipo: 'recorte', medio: 'Mundo Deportivo', tit: 'España, campeona del mundo',
      pie: 'Sudáfrica, 11 de julio de 2010' }
];

/* ── LAS TARJETAS CURADAS ──────────────────────────────────────────────
   Si hay `crucigrama/tarjetas.json` en Storage, MANDA ÉL: cada tarjeta va
   exactamente donde se la ha puesto con admin/colocar_tarjetas.py. Solo las
   divisiones que no tengan ninguna curada caen al reparto automático de más
   abajo, para que el mapa nunca salga pelado mientras se colocan.

   La posición se guarda en FRACCIONES del campo (0..1), no en píxeles: el
   campo mide 375 px en un móvil y 1.000 en un escritorio, así que en píxeles
   la foto se saldría o se plantaría encima del recorrido según la pantalla. */
let crucFotos = null;

function crucValidarTarjeta(t) {
    if (!t || typeof t !== 'object') return null;
    const div = Number(t.div), x = Number(t.x), y = Number(t.y);
    if (!Number.isInteger(div) || div < 1 || div > CRUC_DIVISIONES.length) return null;
    if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
    const img = typeof t.img === 'string' ? t.img.trim() : '';
    const icono = CRUC_ICONOS[t.icono] ? t.icono : 'copa';
    /* `nivel` es el que la DESTAPA, y lo elige quien la coloca. 0 (o fuera de
       rango) = automatico: el nivel cuyo nodo cae mas cerca de la tarjeta. */
    const nivel = Number(t.nivel);
    /* anchoMovil es OPCIONAL: 0 (o ausente) significa "el mismo tamaño que en
       escritorio", que es el comportamiento de siempre. Rango más permisivo
       por abajo que `ancho` (50 en vez de 80) porque para esto existe: para
       poder encoger una tarjeta que en el móvil, con un campo de 375px en vez
       de hasta 1.000, queda desproporcionada aunque en escritorio se vea bien. */
    const anchoMovil = Number(t.anchoMovil);
    return {
        div, x, y, img, icono,
        pie: typeof t.pie === 'string' ? t.pie : '',
        ancho: Math.max(80, Math.min(320, Number(t.ancho) || 132)),
        anchoMovil: (anchoMovil >= 50 && anchoMovil <= 320) ? anchoMovil : 0,
        giro: Math.max(-15, Math.min(15, Number(t.giro) || 0)),
        nivel: (Number.isInteger(nivel) && nivel >= 1 && nivel <= CRUC_TOTAL_NIVELES) ? nivel : 0,
    };
}

/* ── QUE TARJETAS SE HAN VISTO YA ──────────────────────────────────────
   La animacion es de UNA vez: al volver al mapa, una tarjeta ya destapada
   tiene que estar puesta, no volver a revelarse cada vez que entras. La clave
   es `division|imagen` (o el pie si no hay imagen): sobrevive a que las
   reordenes o las muevas de sitio, que es lo que pasa al curarlas. */
const CRUC_TARJ_VISTAS = 'cruc_tarj_vistas';
function crucTarjClave(t) { return t.div + '|' + (t.img || t.pie); }
function crucTarjVistas() {
    try { return new Set(JSON.parse(localStorage.getItem(CRUC_TARJ_VISTAS) || '[]')); }
    catch (e) { return new Set(); }
}
function crucTarjApuntar(clave) {
    try {
        const s = crucTarjVistas();
        s.add(clave);
        localStorage.setItem(CRUC_TARJ_VISTAS, JSON.stringify([...s]));
    } catch (e) { /* sin localStorage se anima cada vez, y no pasa nada */ }
}

/* El nivel mas cercano a la tarjeta, para cuando no se ha elegido uno. */
function crucNivelMasCerca(t, ancho, alto, pts, primero) {
    const x = t.x * ancho, y = t.y * alto;
    let mejor = 0, dm = Infinity;
    pts.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < dm) { dm = d; mejor = i; }
    });
    return primero + mejor;
}

/* NO bloquea el arranque, y es a propósito: una petición más en el camino
   crítico es una forma más de que el mapa no salga (la lección de En el Top
   del 2026-09-01). Si llega, se repinta; si no llega, reparto automático. */
async function crucCargarFotos() {
    if (crucFotos) return;
    try {
        /* Por el proxy (fhFetchData), no directo a Storage: asi lo cachea la
           CDN -son las mismas tarjetas para todo el mundo y cambian cuando se
           curan, no cada dia- y ademas la herramienta de colocarlas puede
           interceptarlo para ensenar en local lo que acabas de mover. El
           respaldo a Supabase ya viene dentro. */
        const res = window.fhFetchData
            ? await fhFetchData('game-data', 'crucigrama/tarjetas.json')
            : await fetch(sbStorageUrl('game-data', 'crucigrama/tarjetas.json'));
        if (!res.ok) throw new Error('sin tarjetas');
        const j = await res.json();
        const lista = (Array.isArray(j) ? j : j.tarjetas || [])
            .map(crucValidarTarjeta).filter(Boolean);
        if (!lista.length) return;
        crucFotos = lista;
        if (document.getElementById('cruc-mapa')) crucPintarMapa();
    } catch (e) { /* sin curar: manda el reparto automático */ }
}

function crucTarjetasCuradas(idxDiv, ancho, alto, k, pts) {
    const n = 1 + (k - 1) * 0.42;
    /* El campo solo crece de 375 a 1.000 -un 167%- mientras que `n` (el
       factor que escala la tarjeta) va de 1 a 1,21 -un 21%-: una tarjeta con
       el mismo ancho en px ocupa mucha más PROPORCIÓN de campo en el móvil
       que en escritorio, y es justo ahí donde se ve "gigantesca". Por eso
       `anchoMovil`, si está puesto, manda tal cual (sin *n) en vez de
       heredar el de escritorio; el corte en 600 es el mismo que usa el
       resto de este archivo para distinguir móvil de escritorio/tablet. */
    const esMovil = ancho <= 600;
    const primero = (crucBloques[idxDiv] || {}).primero || 1;
    const vistas = crucTarjVistas();
    return (crucFotos || []).filter(t => t.div === idxDiv + 1).map(t => {
        const anchoTarj = (esMovil && t.anchoMovil) ? t.anchoMovil : t.ancho * n;
        const sitio = `left:${(t.x * ancho).toFixed(1)}px;top:${(t.y * alto).toFixed(1)}px;`
                    + `--rot:${t.giro}deg;--cruc-tarj-w:${anchoTarj.toFixed(1)}px`;
        const nv = t.nivel || crucNivelMasCerca(t, ancho, alto, pts, primero);

        /* Hasta que no se pasa SU nivel la tarjeta es una interrogacion: se ve
           que ahi hay algo, pero no que es. */
        if (crucEstrellas(nv) === 0) {
            return `<div class="cruc-tarjeta cruc-foto cruc-tarj-bloq" aria-hidden="true"
              data-tarjeta="${idxDiv + 1}" style="${sitio}">
                <div class="cruc-foto-img"></div><div class="cruc-foto-pie"></div></div>`;
        }

        const clave = crucTarjClave(t);
        const nueva = !vistas.has(clave);
        const dentro = t.img
            ? `<div class="cruc-foto-img"><img src="${crucEsc(sbStorageUrl('cruc-fotos', t.img))}"
                 alt="" loading="lazy" decoding="async"></div>`
            : `<div class="cruc-foto-img">${CRUC_ICONOS[t.icono]}</div>`;
        /* Si es nueva el pie sale VACIO: lo escribe a maquina crucRevelarTarjetas(). */
        return `<div class="cruc-tarjeta cruc-foto${nueva ? ' cruc-tarj-nueva' : ''}"
          aria-hidden="true" data-tarjeta="${idxDiv + 1}"
          ${nueva ? `data-clave="${crucEsc(clave)}" data-pie="${crucEsc(t.pie)}"` : ''}
          style="${sitio}">${dentro}
            <div class="cruc-foto-pie">${nueva ? '' : crucEsc(t.pie)}</div></div>`;
    }).join('');
}

/* ── EL REVELADO ───────────────────────────────────────────────────────
   La tarjeta entra recta y a escala corta, y la foto se revela como una
   Polaroid: de borrosa y sin color a nitida. Cuando ya esta quieta, el pie se
   escribe a maquina. Van una detras de otra y no todas a la vez: con tres en
   la misma division revelandose a la vez no se mira ninguna. */
function crucRevelarTarjetas() {
    const nuevas = document.querySelectorAll('.cruc-tarj-nueva');
    if (!nuevas.length) return;
    const suave = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    nuevas.forEach((el, i) => {
        if (el.dataset.revelando) return;     // se la llama por dos vias, ver abajo
        el.dataset.revelando = '1';
        const pie = el.querySelector('.cruc-foto-pie');
        const texto = el.dataset.pie || '';
        crucTarjApuntar(el.dataset.clave);
        if (suave) {
            if (pie) pie.textContent = texto;
            el.classList.remove('cruc-tarj-nueva');
            return;
        }
        setTimeout(() => {
            if (!el.isConnected) return;
            el.classList.add('cruc-tarj-revela');
            setTimeout(() => crucEscribirPie(pie, texto), 780);
            /* Las clases se quitan A MANO, no se deja que las sostenga el
               fill-mode: si la animacion no llega a correr (pestana en segundo
               plano, o un navegador que no compone) lo que se ve tiene que ser
               el estado FINAL, no el de partida — o la foto se queda borrosa y
               a medio revelar para siempre. */
            setTimeout(() => {
                el.classList.remove('cruc-tarj-nueva', 'cruc-tarj-revela');
                if (pie && !pie.textContent) pie.textContent = texto;
            }, 1900);
        }, 180 + i * 300);
    });
}

function crucEscribirPie(el, texto) {
    if (!el) return;
    const cursor = document.createElement('i');
    cursor.className = 'cruc-cursor';
    el.textContent = '';
    el.appendChild(cursor);
    let i = 0;
    const paso = () => {
        if (!el.isConnected) return;          // el mapa se repinto por el camino
        i++;
        cursor.remove();
        el.textContent = texto.slice(0, i);
        if (i < texto.length) { el.appendChild(cursor); setTimeout(paso, 26); }
    };
    setTimeout(paso, 0);
}

/* Dos o tres por división, SIEMPRE en hueco limpio: se comprueba contra el
   trazo de verdad (las muestras de las bézier) y contra los niveles, no
   contra la recta entre nodos — con arcos que se abomban, la línea pasa por
   otro sitio y las fotos acababan encima. */
function crucTarjetas(pts, traza, ancho, idxDiv, k, alto) {
    if ((crucFotos || []).some(t => t.div === idxDiv + 1)) {
        return crucTarjetasCuradas(idxDiv, ancho, alto, k, pts);
    }
    /* La tarjeta crece MENOS que el campo (igual que el nodo): a escala
       completa la caja mide 268x300 y casi nunca encuentra hueco limpio —
       salían 7 en todo el mapa en vez de las ~30 que tocan. */
    const n = 1 + (k - 1) * 0.42;
    const CAJA_W = 132 * n, CAJA_H = 148 * n, RADIO = 46 * n;
    const libre = (x, y) => {
        const hw = CAJA_W / 2, hh = CAJA_H / 2;
        if (x - hw < 4 || x + hw > ancho - 4) return -1;
        let holgura = 1e9;
        for (const p of traza) {
            const dx = Math.abs(p.x - x) - hw, dy = Math.abs(p.y - y) - hh;
            if (dx < 0 && dy < 0) return -1;
            holgura = Math.min(holgura, Math.max(dx, dy));
        }
        for (const p of pts) {
            const dx = Math.abs(p.x - x) - hw - RADIO, dy = Math.abs(p.y - y) - hh - RADIO;
            if (dx < 0 && dy < 0) return -1;
            holgura = Math.min(holgura, Math.max(dx, dy));
        }
        return holgura;
    };
    const sitios = [];
    const yTop = pts[pts.length - 1].y + 90 * n, yBot = pts[0].y - 90 * n;
    for (let y = yTop; y <= yBot; y += 26 * n) {
        for (let f = 0; f <= 4; f++) {
            const x = CAJA_W / 2 + 6 + f * (ancho - CAJA_W - 12) / 4;
            const h = libre(x, y);
            if (h > 0) sitios.push({ x, y, h });
        }
    }
    sitios.sort((a, b) => b.h - a.h);
    const puestas = [];
    for (const s of sitios) {
        if (puestas.length >= 3) break;
        if (puestas.some(p => Math.abs(p.y - s.y) < 230 * n)) continue;
        puestas.push(s);
    }
    return puestas.sort((a, b) => b.y - a.y).map((s, orden) => {
        const h = CRUC_HITOS[(idxDiv * 3 + orden) % CRUC_HITOS.length];
        const rot = (orden % 2 ? 1 : -1) * (2.5 + orden);
        const dentro = h.tipo === 'foto'
            ? `<div class="cruc-foto-img">${CRUC_ICONOS[h.icono]}</div>
               <div class="cruc-foto-pie">${crucEsc(h.pie)}</div>`
            : `<div class="cruc-recorte-medio">${crucEsc(h.medio)}</div>
               <div class="cruc-recorte-tit">${crucEsc(h.tit)}</div>
               <div class="cruc-recorte-pie">${crucEsc(h.pie)}</div>`;
        return `<div class="cruc-tarjeta cruc-${h.tipo}" aria-hidden="true"
          style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px;--rot:${rot}deg">${dentro}</div>`;
    }).join('');
}

let crucBloques = [];

/* `fundido` = entrar al mapa con un fundido, para que el salto de scroll a la
   posición del jugador (o la celebración) no se vea: el mapa se coloca oculto
   y aparece ya en su sitio. Solo al ENTRAR (crucStart / crucVolverAlMapa); los
   repintados internos (redimensionar, llegada de tarjetas) no funden. */
function crucPintarMapa(fundido) {
    const screen = document.getElementById('crucigrama-screen');
    if (!screen) return;
    crucRelojPara();
    crucPaginaFija(true);

    const marcado = `
      <button class="fh-volver" onclick="goToHub()">← Volver</button>
      <div class="cruc-mapa-barra">
        <div class="cruc-mapa-donde">
          <span class="cruc-mapa-eyebrow" id="cruc-div-num">División 1 de 10</span>
          <span class="cruc-mapa-nombre" id="cruc-div-nombre">Fútbol Base</span>
        </div>
        <div class="cruc-contador" id="cruc-contador"></div>
        <a class="cruc-mapa-guia" href="/como-jugar/crucigrama/">Cómo se juega</a>
      </div>
      <div class="cruc-mapa-wrap" id="cruc-mapa-wrap"><div class="cruc-mapa${fundido ? ' cruc-mapa-cargando' : ''}" id="cruc-mapa"></div></div>`;
    screen.innerHTML = marcado;

    const mapa = document.getElementById('cruc-mapa');
    const ancho = mapa.clientWidth || 375;
    const k = crucEscala(ancho);
    const banda = crucBanda(ancho);
    mapa.style.setProperty('--cruc-k', k.toFixed(3));
    const altos = CRUC_DIVISIONES.map(d => crucAltoCampo(d.niveles, ancho));
    const total = altos.reduce((a, b) => a + b, 0) + banda * (CRUC_DIVISIONES.length - 1);
    mapa.style.height = total + 'px';

    /* La división 1 abajo del todo y la última arriba: se sube por el mapa. */
    crucBloques = [];
    let y = 0, primero = 1;
    for (let i = CRUC_DIVISIONES.length - 1; i >= 0; i--) {
        crucBloques[i] = { idx: i, nombre: CRUC_DIVISIONES[i].nombre,
                           niveles: CRUC_DIVISIONES[i].niveles, top: y, alto: altos[i] };
        y += altos[i];
        if (i > 0) y += banda;
    }
    for (let i = 0; i < CRUC_DIVISIONES.length; i++) {
        crucBloques[i].primero = primero;
        primero += CRUC_DIVISIONES[i].niveles;
    }

    const actual = crucNivelActual();
    let html = '';
    crucBloques.forEach(b => {
        const pts = crucPosiciones(b.niveles, ancho, b.alto, b.idx + 1);
        const recorrido = crucRecorrido(pts, b.idx + 1, ancho);
        const camino = recorrido.d;
        let nodos = '';
        pts.forEach((p, i) => {
            const nivel = b.primero + i;
            const est = crucEstrellas(nivel);
            const abierto = crucNivelAbierto(nivel);
            const festeja = crucCelebrar && crucCelebrar.nivel === nivel;
            /* El color del círculo dice cuántas estrellas: 3 oro, 2 azul,
               1 verde (clase cruc-est-N). */
            nodos += `<button class="cruc-nodo${abierto ? '' : ' bloq'}${est > 0 ? ' hecho cruc-est-' + est : ''}${nivel === actual ? ' actual' : ''}${festeja ? ' cruc-nodo-festeja' : ''}"
                data-nivel="${nivel}" style="left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px"
                aria-label="Nivel ${nivel}${abierto ? `, ${est} de 3 estrellas` : ', bloqueado'}">
                <span class="cruc-nodo-estrellas">${crucFilaEstrellas(est)}</span>
                <span class="cruc-nodo-caja">${nivel}${abierto ? '' : crucCandado()}</span>
                ${nivel === actual ? '<span class="cruc-nodo-aqui">Estás aquí</span>' : ''}
              </button>`;
        });
        html += `<div class="cruc-campo" style="top:${b.top}px;height:${b.alto}px">
            ${crucDibujoCampo(ancho, b.alto)}
            <svg class="cruc-lineas" viewBox="0 0 ${ancho} ${b.alto}" aria-hidden="true">
              <path d="${camino}" fill="none" stroke="rgba(0,0,0,.20)"
                    stroke-width="${(12 * k).toFixed(1)}" stroke-linecap="round"/>
              <path d="${camino}" fill="none" stroke="var(--cruc-cal)"
                    stroke-width="${(8.5 * k).toFixed(1)}" stroke-linecap="round"
                    stroke-dasharray="0.5 ${(21 * k).toFixed(1)}"/>
            </svg>
            ${crucTarjetas(pts, recorrido.muestras, ancho, b.idx, k, b.alto)}
            ${nodos}
          </div>`;
        /* La banda anuncia la división de arriba: un cartel de ascenso de
           categoría (emblema + nombre). NO lleva el rango de niveles — eso ya
           se ve en el mapa. El requisito de estrellas solo se canta cuando ya
           has pasado el último nivel de esta y te topas con la puerta cerrada;
           antes no se avisa de nada. */
        if (b.idx < CRUC_DIVISIONES.length - 1) {
            const sig = CRUC_DIVISIONES[b.idx + 1];
            const nSig = b.idx + 2;                       // nº de la división de arriba
            const abierta = crucDivisionAbierta(b.idx + 1);
            const acabada = crucEstrellas(b.primero + b.niveles - 1) > 0;
            const frenado = !abierta && acabada;
            html += `<div class="cruc-banda${frenado ? ' cerrada' : ' abierta'}"
                  style="top:${b.top - banda}px;height:${banda}px">
                <span class="cruc-banda-flechas" aria-hidden="true"></span>
                <div class="cruc-banda-inner">
                  <div class="cruc-banda-emblema">${nSig}${frenado ? crucCandado() : ''}</div>
                  <div class="cruc-banda-txt">
                    <div class="cruc-banda-kicker">División ${nSig} de ${CRUC_DIVISIONES.length}</div>
                    <div class="cruc-banda-tit">${crucEsc(sig.nombre)}</div>
                    ${frenado
                        ? `<div class="cruc-banda-sub">${crucEstrellaSVG(true)}<span>${sig.entrada} estrellas para entrar</span></div>`
                        : `<div class="cruc-banda-sub cruc-banda-sub--ascenso"><span>Ascenso</span></div>`}
                  </div>
                </div>
                <span class="cruc-banda-flechas cruc-banda-flechas--der" aria-hidden="true"></span>
              </div>`;
        }
    });
    mapa.innerHTML = html;

    mapa.querySelectorAll('.cruc-nodo:not(.bloq)').forEach(b => {
        b.addEventListener('click', () => crucAbrirNivel(+b.dataset.nivel));
    });
    const wrap = document.getElementById('cruc-mapa-wrap');
    crucInfoAlMapa(wrap);
    wrap.addEventListener('scroll', () => {
        clearTimeout(crucActualizarBarra._t);
        crucActualizarBarra._t = setTimeout(crucActualizarBarra, 90);
    }, { passive: true });

    /* Si venimos de superar un nivel, el mapa celebra ese nodo (y no el
       "actual", que ya es el SIGUIENTE). La celebración coloca su propio
       scroll y consume crucCelebrar. Si no, el scroll de siempre al nodo
       donde está el jugador. */
    const celebra = crucCelebrar
        && mapa.querySelector(`.cruc-nodo[data-nivel="${crucCelebrar.nivel}"]`);
    requestAnimationFrame(() => {
        /* El scroll VA PRIMERO: crucActualizarBarra mira el centro del scroll
           para decir en qué división estás, así que con scrollTop aún a 0
           mostraría la división de arriba (Leyenda). */
        if (celebra) {
            crucFestejarEnMapa();
        } else {
            const nodo = mapa.querySelector(`.cruc-nodo[data-nivel="${actual}"]`);
            if (nodo) wrap.scrollTop = nodo.offsetTop + nodo.parentElement.offsetTop - wrap.clientHeight * 0.58;
        }
        crucActualizarBarra();
        crucVigilarAnchoMapa();
        /* Ya colocado el scroll: se descubre el mapa (el fundido oculta el
           salto a la posición del jugador / la celebración). */
        mapa.classList.remove('cruc-mapa-cargando');
        /* Despues de colocar el scroll: si se lanza antes, la tarjeta se
           revela mientras el mapa todavia se esta situando y te la pierdes. */
        crucRevelarTarjetas();
    });
    /* Y una segunda via por temporizador, que NO es por si acaso:
       requestAnimationFrame no corre con la pestana oculta, asi que un mapa
       pintado en segundo plano (vuelves de otra app justo despues de pasar un
       nivel) dejaria la tarjeta nueva en opacidad 0 PARA SIEMPRE. Es el mismo
       tropiezo que ya documenta Bingo con la entrada en cascada del carton.
       `crucRevelarTarjetas` se marca cada tarjeta, asi que llamarla dos veces
       no encadena dos revelados. */
    setTimeout(crucRevelarTarjetas, 400);
    /* Reveal GARANTIZADO del mapa: setTimeout sí corre en segundo plano (el rAF
       no), así que aunque el rAF no llegue a quitar la clase, el mapa nunca se
       queda invisible. */
    if (fundido) setTimeout(() => {
        const m = document.getElementById('cruc-mapa');
        if (m) m.classList.remove('cruc-mapa-cargando');
    }, 400);
    /* Misma red para la celebración: si el rAF no corrió (pestaña oculta), el
       nodo festejado se quedaría con las estrellas invisibles. crucFestejarEnMapa
       consume crucCelebrar, así que este respaldo no la repite si ya se hizo. */
    if (crucCelebrar) setTimeout(() => {
        if (crucCelebrar && document.querySelector(`.cruc-nodo[data-nivel="${crucCelebrar.nivel}"]`)) {
            crucFestejarEnMapa();
        }
    }, 450);
}

function crucActualizarBarra() {
    if (!crucBloques.length) return;
    const wrap = document.getElementById('cruc-mapa-wrap');
    if (!wrap) return;
    const centro = wrap.scrollTop + wrap.clientHeight / 2;
    let b = crucBloques[0];
    for (const x of crucBloques) if (centro >= x.top && centro < x.top + x.alto) b = x;
    const num = document.getElementById('cruc-div-num');
    const nom = document.getElementById('cruc-div-nombre');
    const cont = document.getElementById('cruc-contador');
    if (num) num.textContent = `División ${b.idx + 1} de ${CRUC_DIVISIONES.length}`;
    if (nom) nom.textContent = b.nombre;
    /* Mientras el contador está contando hacia arriba (celebración), no se
       pisa: un evento de scroll llegaría a media cuenta y lo dejaría en el
       total de golpe. */
    if (cont && !crucContando) {
        cont.innerHTML = crucEstrellaSVG(true) + `<span>${crucEstrellasTotales()}</span>`;
    }
}

/* ══════════════════ LA CELEBRACIÓN EN EL MAPA ══════════════════
   Se llama tras volver al mapa habiendo superado un nivel. El nodo recién
   ganado se vuelve oro con sus estrellas saltando una a una, un anillo se
   expande y saltan chispas; el contador total cuenta hacia arriba; y luego el
   mapa se desliza suave al siguiente nivel, que te invita con un halo. Si la
   partida abrió una división nueva, sale además el cartel de ascenso. */
function crucFestejarEnMapa() {
    const cel = crucCelebrar;
    crucCelebrar = null;                       // se consume: no se repite al repintar
    if (!cel) return;
    const mapa = document.getElementById('cruc-mapa');
    const wrap = document.getElementById('cruc-mapa-wrap');
    if (!mapa || !wrap) return;
    const nodo = mapa.querySelector(`.cruc-nodo[data-nivel="${cel.nivel}"]`);
    if (!nodo) return;

    const centrar = (el, suave) => {
        const top = el.offsetTop + el.parentElement.offsetTop - wrap.clientHeight * 0.5;
        if (suave && wrap.scrollTo) wrap.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        else wrap.scrollTop = Math.max(0, top);
    };

    centrar(nodo, false);                      // primero, el nodo que se acaba de ganar
    crucCuentaEstrellas(cel.est);

    if (crucSuave()) return;

    /* Se añade directamente, no en un rAF: el nodo ya está pintado y el
       keyframe corre igual. Colgarlo de un rAF anidado lo dejaría sin
       disparar con la pestaña oculta, y como festeja arranca las estrellas en
       opacidad 0, se quedarían invisibles para siempre — el mismo tropiezo de
       la cascada del cartón de Bingo. */
    nodo.classList.add('cruc-festeja-go');
    const caja = nodo.querySelector('.cruc-nodo-caja');
    if (caja) {
        const anillo = document.createElement('span');
        anillo.className = 'cruc-anillo';
        caja.appendChild(anillo);
        setTimeout(() => anillo.remove(), 900);
        crucChispas(caja, cel.est >= 3 ? 16 : 10, true);
    }

    /* Tras la fiesta del nodo, pan al siguiente nivel (que ahora es el actual)
       para dejar claro adónde ir. Solo si es OTRO nodo: al final del juego, o
       con la puerta cerrada, el actual puede ser este mismo. */
    const actual = mapa.querySelector('.cruc-nodo.actual');
    if (actual && actual !== nodo) {
        setTimeout(() => {
            if (!document.body.contains(actual)) return;
            centrar(actual, true);
            const c2 = actual.querySelector('.cruc-nodo-caja');
            if (c2) {
                const halo = document.createElement('span');
                halo.className = 'cruc-halo';
                c2.appendChild(halo);
                setTimeout(() => halo.remove(), 2100);
            }
        }, 1500);
    }
}

/* El contador total cuenta desde (total − ganadas) hasta total. */
function crucCuentaEstrellas(gana) {
    const cont = document.getElementById('cruc-contador');
    if (!cont) return;
    const total = crucEstrellasTotales();
    if (crucSuave() || !gana || gana <= 0) {
        cont.innerHTML = crucEstrellaSVG(true) + `<span>${total}</span>`;
        return;
    }
    crucContando = true;
    cont.innerHTML = crucEstrellaSVG(true) + `<span>${total - gana}</span>`;
    const span = cont.querySelector('span');
    let val = total - gana;
    const paso = () => {
        if (!span.isConnected) { crucContando = false; return; }
        val++;
        span.textContent = val;
        cont.classList.remove('cruc-contador-tic');
        void cont.offsetWidth;
        cont.classList.add('cruc-contador-tic');
        if (val < total) setTimeout(paso, 200);
        else crucContando = false;
    };
    setTimeout(paso, 420);
}

// ── Abrir un nivel ───────────────────────────
async function crucAbrirNivel(nivel) {
    if (!crucNivelAbierto(nivel)) return;
    const d = crucDivisionDe(nivel);
    crucLoading('CARGANDO NIVEL ' + nivel);
    let lista;
    try {
        lista = await crucCargarDivision(d.idx);
    } catch (e) {
        crucArranqueIncompleto = true;
        crucFatal('No se ha podido cargar la división. Comprueba la conexión.');
        return;
    }
    const nivelDatos = lista.find(l => l.n === nivel);
    if (!nivelDatos) { crucFatal('Ese nivel no está disponible.'); return; }

    /* La rejilla empieza SIEMPRE vacía, también si el nivel ya tenía
       estrellas: para mejorarlas hay que hacerlo entero otra vez. */
    crucNivel = nivel;
    crucData = {
        nivel,
        size: [nivelDatos.f, nivelDatos.c],
        /* El id es PROPIO de cada palabra, no su número de casilla: dos
           palabras que arrancan en la misma casilla comparten número, así
           que usarlo de id dejaba 7 identificadores para 10 palabras y el
           crucigrama no se daba nunca por terminado. El número lo recalcula
           crucNormalizeEntry en orden de lectura. */
        words: nivelDatos.w.map((w, i) => ({
            answer: w.a, clue: w.c, row: w.r, col: w.co,
            direction: w.d, number: w.n, id: i + 1
        }))
    };
    crucCells = null;
    crucUserGrid = {};
    crucSolvedWords = new Set();
    crucSelectedWord = null;
    crucSelectedCell = null;
    crucMalas = new Set();
    crucSegundos = 0;
    crucNormalizeEntry(crucData);

    if (window.FHRuta) FHRuta.set({ nivel: String(nivel) });
    buildCrucigramaScreen();
    crucRelojArranca();
}

/* Las posiciones del recorrido se calculan en PÍXELES sobre el ancho real,
   así que al cambiar el tamaño de la ventana hay que rehacerlo. Se guarda el
   nivel que se estaba mirando para volver a él. */
let crucResizeMapa = null;
function crucVigilarAnchoMapa() {
    if (crucResizeMapa) window.removeEventListener('resize', crucResizeMapa);
    let ancho = document.getElementById('cruc-mapa')?.clientWidth || 0;
    crucResizeMapa = () => {
        const mapa = document.getElementById('cruc-mapa');
        if (!mapa) return;
        if (mapa.clientWidth === ancho) return;      // solo importa el ancho
        ancho = mapa.clientWidth;
        clearTimeout(crucVigilarAnchoMapa._t);
        crucVigilarAnchoMapa._t = setTimeout(crucPintarMapa, 150);
    };
    window.addEventListener('resize', crucResizeMapa);
}

function crucVolverAlMapa() {
    crucRelojPara();
    if (window.FHRuta) FHRuta.borrar('nivel');
    crucPintarMapa(true);
}

// ── Arranque ─────────────────────────────────
async function crucStart() {
    crucArranqueIncompleto = false;
    crucPintarMapa(true);
    crucCargarFotos();          // sin await: repinta solo cuando llegue
    /* Si se llega con ?nivel=N y está abierto, se entra directo. */
    const pedido = window.FHRuta ? parseInt(FHRuta.get('nivel'), 10) : NaN;
    if (Number.isFinite(pedido) && pedido >= 1 && pedido <= CRUC_TOTAL_NIVELES
        && crucNivelAbierto(pedido)) {
        await crucAbrirNivel(pedido);
    } else if (window.FHRuta) {
        FHRuta.borrar('nivel');
    }
}

function openCrucigrama() { crucStart(); }

/* Un arranque fallido no se queda muerto: al volver la conexión se reintenta
   solo (js/red.js), que es lo que salvó a En el Top y La Carrera. */
function crucReintentarArranque() {
    if (!crucArranqueIncompleto || crucReintentando) return;
    crucReintentando = true;
    crucLoading('REINTENTANDO…');
    crucStart().finally(() => { crucReintentando = false; });
}
if (window.FHRed && FHRed.alRecuperar) FHRed.alRecuperar(crucReintentarArranque);


function crucNormalizeEntry(entrada) {
    if (entrada._listo) return entrada;
    for (const w of entrada.words) {
        w.length = w.answer.length;
        if (w.number == null) w.number = w.id;
    }
    // La numeración de un crucigrama va por casilla de inicio y en orden de
    // lectura, no por el orden en que se colocaron las palabras: dos palabras
    // que arrancan en la misma casilla comparten número.
    const inicios = [...new Set(entrada.words.map(w => `${w.row},${w.col}`))]
        .map(k => k.split(',').map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const num = new Map(inicios.map(([r, c], i) => [`${r},${c}`, i + 1]));
    for (const w of entrada.words) w.number = num.get(`${w.row},${w.col}`);
    entrada._listo = true;
    return entrada;
}

function crucSize() {
    if (crucData && Array.isArray(crucData.size)) {
        return { rows: crucData.size[0], cols: crucData.size[1] };
    }
    // Formato viejo, por si queda algún archivo sin migrar.
    if (crucData && crucData.grid_size) return crucData.grid_size;
    let rows = 0, cols = 0;
    for (const w of (crucData?.words || [])) {
        const n = w.answer.length;
        rows = Math.max(rows, w.direction === 'down'   ? w.row + n : w.row + 1);
        cols = Math.max(cols, w.direction === 'across' ? w.col + n : w.col + 1);
    }
    return { rows, cols };
}

function crucIsPlayable(r, c) {
    if (!crucCells) {
        crucCells = new Set();
        for (const w of (crucData?.words || [])) {
            for (const p of crucGetWordCells(w)) crucCells.add(`${p.row},${p.col}`);
        }
    }
    return crucCells.has(`${r},${c}`);
}

/* Escapa texto que va por innerHTML. Las pistas son nuestras, pero desde que
   se generan a partir de la base de jugadores llevan apóstrofos y comillas
   (O'Neill, "El Pipita") que romperían el atributo o el marcado. */
function crucEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// ── CONSTRUIR PANTALLA ───────────────────────

function buildCrucigramaScreen() {
    crucPaginaFija(false);
    crucInfoAlCuerpo();
    const screen = document.getElementById('crucigrama-screen');
    /* NO se vacía antes de tener el marcado nuevo. Vaciar y luego construir
       significa que cualquier tropiezo al construir (una fecha con otra
       forma, un dato que falta) deja el contenedor VACIO — y como en esta
       página el <body> es prácticamente solo este div, eso es la pantalla en
       blanco entera, sin siquiera el botón Volver. Se monta la cadena
       completa primero y se asigna de una sola vez. */

    const d = crucDivisionDe(crucNivel);
    const est = crucEstrellas(crucNivel);

    const marcado = `
        <!-- HEADER -->
        <div class="cruc-header">
            <div class="cruc-nav-row">
                <button class="fh-volver" onclick="crucVolverAlMapa()">← Mapa</button>
                <div class="cruc-title-block">
                    <h1 class="cruc-title">NIVEL ${crucNivel}</h1>
                    <div class="cruc-edition">${crucEsc(d.nombre)}</div>
                </div>
                <div class="cruc-estrellas-cab" title="${est} de 3 estrellas">${crucFilaEstrellas(est)}</div>
            </div>
        </div>

        <!-- BODY -->
        <div class="cruc-body">

            <!-- COLUMNA IZQUIERDA: VERTICALES (solo desktop) -->
            <div class="cruc-clues-desktop" id="cruc-clues-down"></div>

            <!-- COLUMNA CENTRAL -->
            <div class="cruc-center-col">
                <!-- GRID -->
                <div class="cruc-grid-wrapper">
                    <div class="cruc-grid" id="cruc-grid"></div>
                </div>

                <!-- PISTA ACTIVA -->
                <div class="cruc-clue-bar" id="cruc-clue-bar">
                    <div class="cruc-clue-empty">Pulsa una casilla para ver la pista</div>
                </div>

                <!-- TECLADO VIRTUAL (desktop) -->
                <div class="cruc-keyboard" id="cruc-keyboard">
                    <div class="cruc-keyboard-row">
                        ${['Q','W','E','R','T','Y','U','I','O','P'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                    </div>
                    <div class="cruc-keyboard-row">
                        ${['A','S','D','F','G','H','J','K','L','Ñ'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                    </div>
                    <div class="cruc-keyboard-row">
                        <button class="cruc-key cruc-key--wide" onclick="crucHandleKey('Delete')">⌫</button>
                        ${['Z','X','C','V','B','N','M'].map(k =>
                            `<button class="cruc-key" data-cruc-key="${k}" onclick="crucHandleKey('${k}')">${k}</button>`
                        ).join('')}
                        <button class="cruc-key cruc-key--wide" onclick="crucHandleKey('Tab')">→</button>
                    </div>
                </div>

                <!-- TAP BAR MÓVIL -->
                <div class="cruc-tap-bar" id="cruc-tap-bar" onclick="crucFocusMobile()">
                    Toca aquí para escribir ✏️
                </div>

            </div>

            <!-- COLUMNA DERECHA: HORIZONTALES (solo desktop) -->
            <div class="cruc-clues-desktop" id="cruc-clues-across"></div>

        </div>

        <!-- BOTTOM BAR -->
        <div class="cruc-bottom-bar">
            <!-- Aviso pequeño y permanente sobre Finalizar (línea superior). -->
            <div class="cruc-finalizar-nota">
                Puedes <b>finalizar</b> aunque te falten 1 o 2 palabras: pasas de nivel igual.
            </div>
            <div class="cruc-progress">
                <span id="cruc-solved-count">${crucSolvedWords.size}</span>/${crucData.words.length} palabras
                <span class="cruc-reloj" id="cruc-reloj">${crucFormatoTiempo(crucSegundos)}</span>
            </div>
            <div class="cruc-actions">
                <!-- Solo se ve en movil: en escritorio las pistas ya estan en las
                     dos columnas laterales, asi que el boton sobra. -->
                <button class="cruc-btn-reveal cruc-btn-clues" onclick="crucToggleCluesSheet()">Pistas</button>
                <!-- Finalizar: cierra el nivel con las palabras que llevas, por si
                     te vale con una o dos estrellas. No hay revelar. -->
                <button class="cruc-btn-reveal cruc-btn-finalizar" onclick="crucFinalizar()"
                        title="Puedes finalizar aunque te falten 1 o 2 palabras: pasas de nivel igual.">Finalizar</button>
            </div>
        </div>

        <!-- PANEL DE PISTAS (movil) -->
        <div class="cruc-clues-sheet" id="cruc-clues-sheet" onclick="crucCluesSheetBackdrop(event)">
            <div class="cruc-clues-sheet-inner">
                <div class="cruc-clues-sheet-head">
                    <span>Todas las pistas</span>
                    <button class="cruc-clues-sheet-close" onclick="crucCloseCluesSheet()">&#10005;</button>
                </div>
                <div class="cruc-clues-sheet-body" id="cruc-clues-mobile"></div>
            </div>
        </div>

        <!-- RESULTADO DEL NIVEL -->
        <div class="cruc-completion-modal" id="cruc-completion-modal">
            <div class="cruc-completion-content">
                <div class="cruc-comp-estrellas" id="cruc-comp-estrellas"></div>
                <div class="cruc-completion-title" id="cruc-comp-title">NIVEL SUPERADO</div>
                <div class="cruc-completion-sub" id="cruc-comp-sub"></div>
                <div class="cruc-completion-stats">
                    <div class="cruc-comp-stat">
                        <div class="cruc-comp-stat-value" id="cruc-comp-words">—</div>
                        <div class="cruc-comp-stat-label">Palabras</div>
                    </div>
                    <div class="cruc-comp-stat">
                        <div class="cruc-comp-stat-value" id="cruc-comp-time">—</div>
                        <div class="cruc-comp-stat-label">Tiempo</div>
                    </div>
                </div>
                <p class="cruc-comp-texto" id="cruc-comp-texto"></p>
                <div class="cruc-completion-btns">
                    <button class="next-btn" id="cruc-comp-seguir">Continuar →</button>
                    <button class="give-up-btn" id="cruc-share-btn" onclick="crucShare()">📤 Compartir</button>
                    <button class="give-up-btn" id="cruc-comp-mapa" onclick="crucVolverAlMapa()">Ir al mapa</button>
                </div>
            </div>
        </div>

    `;

    screen.innerHTML = marcado;

    renderGrid();
    renderCluesList();

    // Recalcular tamaño si cambia el viewport
    window._crucResizeHandler && window.removeEventListener('resize', window._crucResizeHandler);
    window._crucResizeHandler = () => {
        crucCeldaForzada = 0;
        const t = document.getElementById('cruc-keyboard');
        if (t) t.style.display = '';       // se le vuelve a dar la oportunidad
        renderGrid();
        crucAjustarAlto();
    };
    window.addEventListener('resize', window._crucResizeHandler);
    if (!crucCeldaForzada) {
        crucAjustarAlto();
        /* Y otra vez con las fuentes ya cargadas: al primer render los textos
           miden menos de lo que van a medir (fuente de respaldo), así que
           entonces "cabe" y un segundo después ya no. */
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                if (document.getElementById('cruc-grid')) crucAjustarAlto();
            });
        }
        setTimeout(() => { if (document.getElementById('cruc-grid')) crucAjustarAlto(); }, 400);
    }
}

/* Una sola pasada de correccion: se mide lo que sobresale y se recorta la
   celda lo justo. Solo achica, nunca agranda, y no se encadena. */
function crucAjustarAlto(vuelta) {
    vuelta = vuelta || 0;
    const barra = document.querySelector('.cruc-bottom-bar');
    const celda = document.querySelector('.cruc-cell');
    if (!barra || !celda || vuelta > 3) return;

    /* LO PRIMERO: que las columnas de pistas no estiren la página. Si son
       ELLAS las que se salen, lo que sobra no lo arregla encoger la rejilla
       —el bucle de abajo la hunde hasta el suelo y no sirve de nada—. Medido
       en un portátil de 1.366x768, que es lo normal: la columna de
       HORIZONTALES media 576 px, la rejilla acababa con casillas de 20 px y
       la página seguía igual de larga. El `max-height` que tenían en el CSS
       (100vh - 160) se quedaba corto porque no descuenta ni la cabecera ni la
       barra de abajo; aquí se miden de verdad y las columnas se desplazan por
       dentro, que es lo que tiene que pasar cuando hay diez pistas largas. */
    const columnas = document.querySelectorAll('.cruc-clues-desktop');
    if (columnas.length && columnas[0].offsetParent !== null) {
        /* Se mide desde donde empieza la COLUMNA, no desde el cuerpo: entre
           uno y otra hay 20 px de relleno, y contarlos de menos dejaba el
           tope justo 20 px largo — o sea el desbordamiento seguía ahí. */
        const arriba = columnas[0].getBoundingClientRect().top;
        /* Sólo 10 px de aire hasta la barra: así las columnas LLEGAN a la
           línea del temporizador en vez de quedarse cortas con un hueco. */
        const hueco = window.innerHeight - arriba
                    - barra.getBoundingClientRect().height - 10;
        /* Se fija la ALTURA, no un max-height: con altura la columna llega a la
           línea aunque tenga pocas pistas (el fondo del panel rellena hasta
           abajo por el `flex:1` de la sección), y al ser fija no da el salto de
           "se ve entera y luego se recorta" cuando las fuentes cargan y el
           texto crece — la caja no cambia de tamaño, sólo aparece el scroll. */
        const alto = Math.max(220, hueco);
        columnas.forEach(c => { c.style.height = alto + 'px'; c.style.maxHeight = 'none'; });
    }

    const sobra = barra.getBoundingClientRect().bottom - window.innerHeight;
    if (sobra <= 0) return;

    /* En escritorio, antes de achicar la rejilla hasta lo ridículo, que ceda
       el teclado en pantalla: ahí hay teclado de verdad y son 158 px que le
       vienen mucho mejor a las casillas. Solo cuando la celda se quedaría por
       debajo de 38 px. */
    const tec = document.getElementById('cruc-keyboard');
    if (window.innerWidth > 600 && tec && tec.offsetParent !== null
        && celda.getBoundingClientRect().width < 38) {
        tec.style.display = 'none';
        crucCeldaForzada = 0;
        renderGrid();
        crucAjustarAlto(vuelta + 1);
        return;
    }
    /* Lo que sobra no baja en proporcion exacta al tamano de celda -hay
       margenes y bordes por medio-, asi que converge en dos o tres pasadas
       en vez de intentar acertar de una. */
    const { rows } = crucSize();
    const actual = celda.getBoundingClientRect().width;
    /* Suelo de 30 px, no de 20. Una casilla de 20 px no es un crucigrama
       pequeno: es un crucigrama que no se ve. Si con 30 sigue sin caber,
       mejor que la pagina se desplace un poco. */
    const nuevo = Math.max(30, Math.floor(actual - Math.max(1, Math.ceil(sobra / rows))));
    if (nuevo >= actual) return;
    crucCeldaForzada = nuevo;
    renderGrid();
    crucCeldaForzada = 0;
    crucAjustarAlto(vuelta + 1);
}

// ── RENDER GRID ──────────────────────────────

/* Si tras pintar la barra de acciones se sale de la ventana, se repinta una
   vez con la celda mas pequena. Estimar el "cromo" (cabecera, pista, teclado,
   acciones) con constantes nunca acierta del todo: las fuentes cargan tarde y
   los textos ocupan lo que ocupan. Medir y corregir una vez si acierta. */
let crucCeldaForzada = 0;

function renderGrid() {
    const container = document.getElementById('cruc-grid');
    if (!container || !crucData) return;

    const { rows, cols } = crucSize();

    // Calcular tamaño de celda dinámicamente según el ancho disponible
    /* Tres tamaños de pantalla, no dos: las columnas de pistas solo salen a
       partir de 1180 (ver crucigrama.css), asi que entre 601 y 1179 el ancho
       util es TODO el contenedor, no el de la columna central. */
    const conColumnas = window.innerWidth >= 1180;
    const anchoAmplio = window.innerWidth > 600;
    const availableWidth = conColumnas
        ? Math.min(window.innerWidth - 32 - 2 * 260, 520)
        : Math.min(window.innerWidth - 32, 560);

    /* El alto se descuenta de verdad, no por un porcentaje a ojo: cabecera,
       barra de pista, teclado y barra de acciones son piezas fijas y si no se
       restan la pagina crece y los botones quedan fuera de la ventana (a
       1000x900 la pagina medía 1.421 px y las acciones acababan en 957). */
    const cabecera = document.querySelector('.cruc-header');
    const teclado  = document.getElementById('cruc-keyboard');
    const acciones = document.querySelector('.cruc-bottom-bar');
    const alto = e => (e ? e.getBoundingClientRect().height : 0);
    const chrome = alto(cabecera) + alto(acciones)
                 + (anchoAmplio ? alto(teclado) : 0)
                 + 104                                 // barra de pista + huecos
                 + (anchoAmplio ? 40 : 96);            // en movil, la tap-bar
    const availableHeight = Math.max(200, window.innerHeight - chrome);

    const cellByWidth  = Math.floor((availableWidth  - 10) / cols);
    const cellByHeight = Math.floor((availableHeight - 10) / rows);
    // En móvil bajamos el mínimo a 20px para que crucigramas grandes quepan en pantalla
    const cellSize = crucCeldaForzada
        || Math.max(anchoAmplio ? 26 : 20, Math.min(52, cellByWidth, cellByHeight));

    container.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
    container.innerHTML = '';

    // Inyectar tamaño dinámico en el DOM para que el CSS lo use
    let styleEl = document.getElementById('cruc-dynamic-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'cruc-dynamic-style';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
        .cruc-cell { width: ${cellSize}px; height: ${cellSize}px; }
        .cruc-cell-letter { font-size: ${Math.round(cellSize * 0.62)}px; }
        .cruc-cell-number { font-size: ${Math.max(7, Math.round(cellSize * 0.22))}px; }
    `;

    // Build number map: (r,c) -> number
    const numMap = {};
    for (const w of crucData.words) {
        const key = `${w.row},${w.col}`;
        if (!numMap[key]) numMap[key] = w.number;
    }

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = document.createElement('div');
            cell.className = 'cruc-cell';
            cell.dataset.row = r;
            cell.dataset.col = c;

            if (!crucIsPlayable(r, c)) {
                cell.classList.add('cruc-cell--black');
            } else {
                cell.classList.add('cruc-cell--white');

                // Number
                const key = `${r},${c}`;
                if (numMap[key]) {
                    const numEl = document.createElement('div');
                    numEl.className = 'cruc-cell-number';
                    numEl.textContent = numMap[key];
                    cell.appendChild(numEl);
                }

                // Letter
                const letEl = document.createElement('div');
                letEl.className = 'cruc-cell-letter';
                letEl.id = `cruc-letter-${r}-${c}`;
                letEl.textContent = crucUserGrid[key] || '';
                cell.appendChild(letEl);

                cell.addEventListener('click', () => crucClickCell(r, c));

                // Apply state classes
                applyCellClasses(cell, r, c);
            }

            container.appendChild(cell);
        }
    }
}

function applyCellClasses(cell, r, c) {
    cell.classList.remove('cruc-cell--word-active', 'cruc-cell--selected',
                          'cruc-cell--correct', 'cruc-cell--wrong');

    if (crucMalas.has(`${r},${c}`)) {
        cell.classList.add('cruc-cell--wrong');
    } else if (crucIsCellCorrect(r, c)) {
        cell.classList.add('cruc-cell--correct');
    }

    if (crucSelectedWord) {
        const w = crucSelectedWord;
        for (let i = 0; i < w.length; i++) {
            const wr = w.direction === 'across' ? w.row : w.row + i;
            const wc = w.direction === 'across' ? w.col + i : w.col;
            if (wr === r && wc === c) {
                cell.classList.add('cruc-cell--word-active');
                break;
            }
        }
    }

    if (crucSelectedCell && crucSelectedCell.row === r && crucSelectedCell.col === c) {
        cell.classList.add('cruc-cell--selected');
    }
}

function updateCellVisual(r, c) {
    const cell = document.querySelector(`.cruc-cell[data-row="${r}"][data-col="${c}"]`);
    if (!cell) return;
    const letEl = document.getElementById(`cruc-letter-${r}-${c}`);
    if (letEl) letEl.textContent = crucUserGrid[`${r},${c}`] || '';
    applyCellClasses(cell, r, c);
}

function refreshAllCells() {
    if (!crucData) return;
    const { rows, cols } = crucSize();
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (crucIsPlayable(r, c)) updateCellVisual(r, c);
}

// ── RENDER PISTAS ────────────────────────────

function renderCluesList() {
    if (!crucData) return;

    const across = crucData.words.filter(w => w.direction === 'across').sort((a,b) => a.number - b.number);
    const down   = crucData.words.filter(w => w.direction === 'down').sort((a,b) => a.number - b.number);

    // El panel de movil llama a otra funcion para cerrarse solo al elegir; en
    // las columnas de escritorio no hay nada que cerrar.
    const buildList = (words, alElegir) => words.map(w => {
        const isActive  = crucSelectedWord && crucSelectedWord.id === w.id;
        const isSolved  = crucSolvedWords.has(w.id);
        return `<div class="cruc-clue-item ${isActive ? 'active' : ''} ${isSolved ? 'solved' : ''}"
                     onclick="${alElegir}(${w.id})" data-clue-id="${w.id}">
                    <div class="cruc-clue-num">${w.number}</div>
                    <div class="cruc-clue-desc">${crucEsc(w.clue)}</div>
                </div>`;
    }).join('');

    const seccion = (titulo, words, alElegir) => `
        <div class="cruc-clues-section">
            <div class="cruc-clues-heading">${titulo}</div>
            ${buildList(words, alElegir)}
        </div>`;

    const colDown   = document.getElementById('cruc-clues-down');
    const colAcross = document.getElementById('cruc-clues-across');
    if (colDown)   colDown.innerHTML   = seccion('VERTICALES',   down,   'crucSelectWordById');
    if (colAcross) colAcross.innerHTML = seccion('HORIZONTALES', across, 'crucSelectWordById');

    // Movil: las dos listas juntas dentro del panel desplegable.
    const movil = document.getElementById('cruc-clues-mobile');
    if (movil) movil.innerHTML = seccion('HORIZONTALES', across, 'crucSelectFromSheet')
                               + seccion('VERTICALES',   down,   'crucSelectFromSheet');
}

// ── PANEL DE PISTAS (MOVIL) ──────────────────
/* En escritorio las pistas viven en las dos columnas laterales. En movil no
   caben, y hasta ahora solo se veia la pista de la palabra en la que estabas:
   este panel ensena las dos listas completas, horizontales y verticales. */

function crucToggleCluesSheet() {
    const sheet = document.getElementById('cruc-clues-sheet');
    if (!sheet) return;
    if (sheet.classList.contains('open')) return crucCloseCluesSheet();
    renderCluesList();                       // por si cambio algo desde la ultima vez
    sheet.classList.add('open');
    document.body.classList.add('cruc-sheet-abierto');
    // Deja a la vista la pista en la que estas, que puede estar muy abajo.
    const activa = sheet.querySelector('.cruc-clue-item.active');
    if (activa) activa.scrollIntoView({ block: 'center' });
}

function crucCloseCluesSheet() {
    const sheet = document.getElementById('cruc-clues-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    document.body.classList.remove('cruc-sheet-abierto');
}

/* Solo cierra si el toque cae en el velo, no dentro de la lista. */
function crucCluesSheetBackdrop(e) {
    if (e.target.id === 'cruc-clues-sheet') crucCloseCluesSheet();
}

function crucSelectFromSheet(id) {
    crucCloseCluesSheet();
    crucSelectWordById(id);
}

function updateCluesPanel() {
    if (!crucData) return;
    // Update active/solved states in all clue containers (panel móvil + columnas desktop)
    document.querySelectorAll('.cruc-clue-item').forEach(item => {
        const id = parseInt(item.dataset.clueId);
        item.classList.toggle('active',  crucSelectedWord?.id === id);
        item.classList.toggle('solved',  crucSolvedWords.has(id));
    });
}

function updateClueBar() {
    const bar = document.getElementById('cruc-clue-bar');
    if (!bar) return;
    if (!crucSelectedWord) {
        bar.innerHTML = '<div class="cruc-clue-empty">Pulsa una casilla para ver la pista</div>';
        return;
    }
    const w   = crucSelectedWord;
    const dir = w.direction === 'across' ? '→ HORIZONTAL' : '↓ VERTICAL';
    bar.innerHTML = `
        <div class="cruc-clue-direction">${w.number} ${dir}</div>
        <div class="cruc-clue-text">${crucEsc(w.clue)}</div>`;
}

// ── INTERACCIÓN CON CELDAS ───────────────────

function crucClickCell(r, c) {
    if (!crucData) return;

    // Find all words containing this cell
    const words = crucGetWordsAtCell(r, c);
    if (words.length === 0) return;

    // Una casilla con número es el INICIO de una o dos palabras (esa
    // numeración concreta). Pulsarla debe llevar a la pista de ESE número, no
    // a la palabra que solo pasa por ahí en la dirección en la que ya estabas.
    const inicianAqui = words.filter(w => w.row === r && w.col === c);
    const candidatos  = inicianAqui.length ? inicianAqui : words;

    // If already selected and clicking same cell: toggle direction
    if (crucSelectedCell && crucSelectedCell.row === r && crucSelectedCell.col === c
        && crucSelectedWord && candidatos.length > 1) {
        const otherDir = crucSelectedWord.direction === 'across' ? 'down' : 'across';
        const altWord  = candidatos.find(w => w.direction === otherDir);
        if (altWord) {
            crucSelectedWord = altWord;
        }
    } else {
        // Prefer same direction if possible, else first available
        let word = candidatos.find(w => w.direction === (crucSelectedWord?.direction || 'across'));
        if (!word) word = candidatos[0];
        crucSelectedWord = word;
    }

    crucSelectedCell = { row: r, col: c };

    refreshAllCells();
    updateClueBar();
    updateCluesPanel();

    // En móvil: enfocar el input oculto para mostrar el teclado nativo
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) {
        crucFocusMobile();
    }
}

function crucSelectWordById(id) {
    const w = crucData.words.find(x => x.id === id);
    if (!w) return;
    crucSelectedWord = w;
    crucSelectedCell = { row: w.row, col: w.col };
    refreshAllCells();
    updateClueBar();
    updateCluesPanel();
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) {
        crucFocusMobile();
    }
    // Scroll grid into view on mobile
    const grid = document.getElementById('cruc-grid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function crucGetWordsAtCell(r, c) {
    return crucData.words.filter(w => {
        for (let i = 0; i < w.length; i++) {
            const wr = w.direction === 'across' ? w.row : w.row + i;
            const wc = w.direction === 'across' ? w.col + i : w.col;
            if (wr === r && wc === c) return true;
        }
        return false;
    });
}

// ── ENTRADA DE LETRAS ────────────────────────

function crucHandleKey(key) {
    if (!crucSelectedCell || !crucSelectedWord) return;
    if (crucIsComplete()) return;

    const { row, col } = crucSelectedCell;
    const w = crucSelectedWord;

    if (key === 'Delete' || key === 'Backspace') {
        const cellKey = `${row},${col}`;
        // Una palabra ya acertada no se puede borrar: se ha comprobado que es
        // correcta, y deshacerla sería perder un acierto por error de tecleo.
        if (crucUserGrid[cellKey]) {
            if (!crucIsCellCorrect(row, col)) {
                delete crucUserGrid[cellKey];
                // Re-comprobar TODAS las palabras que pasan por la celda: si alguna
                // estaba marcada como resuelta, al borrar la letra deja de estarlo
                // (antes quedaba "resuelta" para siempre y podía dar falso completado).
                crucGetWordsAtCell(row, col).forEach(wd => crucCheckWordSolved(wd));
                updateCellVisual(row, col);
            }
        } else {
            // Move backwards
            const prev = crucGetPrevCell(w, row, col);
            if (prev) {
                crucSelectedCell = prev;
                if (!crucIsCellCorrect(prev.row, prev.col)) {
                    const prevKey = `${prev.row},${prev.col}`;
                    delete crucUserGrid[prevKey];
                    crucGetWordsAtCell(prev.row, prev.col).forEach(wd => crucCheckWordSolved(wd));
                    updateCellVisual(prev.row, prev.col);
                }
                refreshAllCells();
            }
        }
        crucSave();
        return;
    }

    if (key === 'Tab') {
        crucAdvanceToNextWord();
        return;
    }

    // Las flechas mueven el cursor por la rejilla, que es lo que espera
    // cualquiera que haya hecho un crucigrama. Antes saltaban a la palabra
    // siguiente, así que no había forma de recolocarse sin ratón.
    if (key.startsWith('Arrow')) {
        crucMoverCursor(key);
        return;
    }

    if (!/^[A-ZÁÉÍÓÚÜÑ]$/i.test(key)) return;

    // Casilla de una palabra ya acertada: no se pisa, solo se avanza el
    // cursor como si se hubiera escrito, para no romper el flujo de tecleo.
    if (crucIsCellCorrect(row, col)) {
        const next = crucGetNextCell(w, row, col);
        if (next) {
            crucSelectedCell = next;
            refreshAllCells();
        }
        return;
    }

    const letter = crucNormalize(key);
    const cellKey = `${row},${col}`;
    crucUserGrid[cellKey] = letter;
    updateCellVisual(row, col);

    // Check if word is solved — comprobar TODAS las palabras que pasan por la
    // celda, no solo la seleccionada: una letra puede completar también la
    // palabra perpendicular (antes esa palabra nunca se marcaba como resuelta
    // y el crucigrama no se podía completar rellenándolo solo en un sentido).
    crucGetWordsAtCell(row, col).forEach(wd => crucCheckWordSolved(wd));

    // Advance cursor
    const next = crucGetNextCell(w, row, col);
    if (next) {
        crucSelectedCell = next;
        refreshAllCells();
    }

    crucSave();

    // Check full completion
    if (crucIsComplete()) {
        setTimeout(() => crucShowCompletion(), 500);
    }
}

/* Compara dos letras YA normalizadas aceptando N donde la respuesta es Ñ:
   quien ve una Ñ en pantalla puede teclear N y cuenta como acierto. Es
   simétrico (también N↔Ñ), lo cual es inofensivo — cada casilla tiene una
   sola letra correcta. */
function crucLetrasIguales(a, b) {
    if (a === b) return true;
    const sinTilde = x => (x === 'Ñ' ? 'N' : x);
    return sinTilde(a) === sinTilde(b);
}

function crucNormalize(letter) {
    // La \u00d1 es una letra distinta de la N: si se le quitan los acentos con
    // normalize('NFD'), su virgulilla se descompone en un car\u00e1cter combinante
    // que cae dentro del rango que borramos abajo, convirti\u00e9ndola en "N" y
    // rompiendo la comparaci\u00f3n (aceptar\u00eda N donde deber\u00eda exigir \u00d1, o viceversa).
    // Por eso se comprueba la \u00d1 ANTES de descomponer y se devuelve intacta.
    const upper = letter.normalize('NFC').toUpperCase();
    if (upper === '\u00d1') return '\u00d1';
    return upper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function crucGetNextCell(word, r, c) {
    const positions = crucGetWordCells(word);
    const idx = positions.findIndex(p => p.row === r && p.col === c);
    if (idx === -1 || idx >= positions.length - 1) return null;
    return positions[idx + 1];
}

function crucGetPrevCell(word, r, c) {
    const positions = crucGetWordCells(word);
    const idx = positions.findIndex(p => p.row === r && p.col === c);
    if (idx <= 0) return null;
    return positions[idx - 1];
}

function crucGetWordCells(word) {
    const cells = [];
    for (let i = 0; i < word.length; i++) {
        cells.push({
            row: word.direction === 'across' ? word.row : word.row + i,
            col: word.direction === 'across' ? word.col + i : word.col
        });
    }
    return cells;
}

/* Mueve el cursor a la siguiente casilla jugable en esa dirección. Si el
   movimiento es perpendicular a la palabra activa, cambia también de palabra:
   bajar estando en una horizontal debe dejarte editando la vertical. */
function crucMoverCursor(tecla) {
    if (!crucSelectedCell) return;
    const pasos = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const [df, dc] = pasos[tecla] || [0, 0];
    const { rows, cols } = crucSize();
    let { row, col } = crucSelectedCell;

    for (let i = 0; i < Math.max(rows, cols); i++) {
        row += df; col += dc;
        if (row < 0 || col < 0 || row >= rows || col >= cols) return;
        if (!crucIsPlayable(row, col)) continue;

        crucSelectedCell = { row, col };
        const quiere = (df !== 0) ? 'down' : 'across';
        const aqui = crucGetWordsAtCell(row, col);
        crucSelectedWord = aqui.find(w => w.direction === quiere)
                        || aqui.find(w => w.id === crucSelectedWord?.id)
                        || aqui[0];
        refreshAllCells();
        updateClueBar();
        updateCluesPanel();
        return;
    }
}

function crucAdvanceToNextWord() {
    if (!crucData || !crucSelectedWord) return;
    const words   = crucData.words;
    const idx     = words.findIndex(w => w.id === crucSelectedWord.id);
    const nextIdx = (idx + 1) % words.length;
    const next    = words[nextIdx];
    crucSelectedWord = next;
    crucSelectedCell = { row: next.row, col: next.col };
    refreshAllCells();
    updateClueBar();
    updateCluesPanel();
}

// ── COMPROBACIÓN DE PALABRAS ─────────────────

function crucCheckWordSolved(word) {
    const cells = crucGetWordCells(word);
    for (let i = 0; i < cells.length; i++) {
        const { row, col } = cells[i];
        const entered = crucUserGrid[`${row},${col}`] || '';
        const correct = crucNormalize(word.answer[i]);
        if (!crucLetrasIguales(entered, correct)) {
            crucSolvedWords.delete(word.id);
            updateCluesPanel();
            return false;
        }
    }
    const eraNueva = !crucSolvedWords.has(word.id);
    crucSolvedWords.add(word.id);
    // Update progress
    const countEl = document.getElementById('cruc-solved-count');
    if (countEl) countEl.textContent = crucSolvedWords.size;
    updateCluesPanel();
    // Flash solved word cells
    cells.forEach(({ row, col }) => updateCellVisual(row, col));
    // Solo al PASAR de no-resuelta a resuelta se anima la onda: si no, cada
    // tecla de una palabra ya buena la relanzaría.
    if (eraNueva) crucOndaPalabra(cells);
    return true;
}

/* Onda en cascada por las casillas de una palabra recién resuelta. Cada
   casilla salta con un retardo según su posición; refresca el estado al
   terminar para que quede el verde de "correcta" limpio. */
function crucOndaPalabra(cells) {
    if (crucSuave()) return;
    cells.forEach((p, i) => {
        const cell = document.querySelector(`.cruc-cell[data-row="${p.row}"][data-col="${p.col}"]`);
        if (!cell) return;
        cell.style.setProperty('--onda-i', i);
        cell.classList.remove('cruc-cell-onda');
        void cell.offsetWidth;                 // reinicia la animación
        cell.classList.add('cruc-cell-onda');
        setTimeout(() => cell.classList.remove('cruc-cell-onda'), 620 + i * 55);
    });
}

function crucIsCellCorrect(r, c) {
    // A cell is "correct" if every word through it is solved
    const words = crucGetWordsAtCell(r, c);
    if (words.length === 0) return false;
    return words.some(w => crucSolvedWords.has(w.id));
}

function crucIsComplete() {
    if (!crucData) return false;
    return crucData.words.every(w => crucSolvedWords.has(w.id));
}

// ── COMPLETION MODAL ─────────────────────────

function crucShowCompletion(revealed = false) {
    crucRelojPara();
    const modal = document.getElementById('cruc-completion-modal');
    if (!modal) return;

    const total  = crucData.words.length;
    const solved = crucSolvedWords.size;
    const est    = crucEstrellasDe(solved);
    const paso   = est > 0;
    const mejora = paso && crucApuntarEstrellas(crucNivel, est);
    const d      = crucDivisionDe(crucNivel);

    document.getElementById('cruc-comp-title').textContent =
        paso ? (est === 3 ? '¡LAS TRES ESTRELLAS!' : 'NIVEL SUPERADO') : 'NO HAS PASADO';
    document.getElementById('cruc-comp-sub').textContent =
        `Nivel ${crucNivel} · ${d.nombre}`;
    document.getElementById('cruc-comp-words').textContent = `${solved}/${total}`;
    document.getElementById('cruc-comp-time').textContent  = crucFormatoTiempo(crucSegundos);

    const estr = document.getElementById('cruc-comp-estrellas');
    if (estr) crucRevelarEstrellasResultado(estr, est);

    const contenido = modal.querySelector('.cruc-completion-content');
    if (contenido) contenido.classList.toggle('cruc-comp-pleno', est === 3);

    const texto = document.getElementById('cruc-comp-texto');
    if (texto) {
        texto.textContent = paso
            ? (est === 3 ? 'Las diez palabras. Pleno.'
             : est === 2 ? 'Una fallada. Te falta una estrella.'
             : 'Dos falladas. Repítelo si quieres las tres estrellas.')
            : `Con ${total - solved} sin acertar no se pasa de nivel. Se pasa fallando dos como mucho.`;
        if (mejora) texto.textContent += ' Marca mejorada.';
    }

    /* SIEMPRE se vuelve por el mapa: al superar, "Continuar" lleva al mapa y
       ahí se celebra el nodo (crucCelebrar). Desde el mapa el jugador pulsa el
       siguiente nivel — el mapa es la navegación. Si no ha pasado, "Reintentar"
       rehace el mismo nivel. */
    const seguir = document.getElementById('cruc-comp-seguir');
    const mapaBtn = document.getElementById('cruc-comp-mapa');
    if (seguir) {
        if (!paso) {
            seguir.textContent = 'Reintentar nivel';
            seguir.onclick = () => { crucCloseCompletion(); crucAbrirNivel(crucNivel); };
        } else {
            seguir.textContent = 'Continuar →';
            seguir.onclick = () => {
                crucCelebrar = { nivel: crucNivel, est };
                crucCloseCompletion();
                crucVolverAlMapa();
            };
        }
    }
    /* El botón secundario "Ir al mapa" solo tiene sentido cuando NO se ha
       pasado (ahí el principal es Reintentar). Al superar es redundante con
       Continuar, así que se esconde. */
    if (mapaBtn) {
        mapaBtn.hidden = paso;
        mapaBtn.onclick = () => { crucCloseCompletion(); crucVolverAlMapa(); };
    }

    modal.classList.add('active');
}

/* Las estrellas del resultado entran una a una con rebote; las ganadas con un
   destello dorado, y con las tres un estallido de chispas. */
function crucRevelarEstrellasResultado(cont, est) {
    cont.innerHTML = crucFilaEstrellas(est);
    const svgs = cont.querySelectorAll('svg');
    if (crucSuave()) return;
    svgs.forEach((s, i) => {
        s.classList.add('cruc-star-in');
        if (i < est) s.classList.add('cruc-star-gana');
        s.style.animationDelay = (0.12 + i * 0.24).toFixed(2) + 's';
    });
    if (est >= 3) {
        setTimeout(() => crucChispas(cont, 16, true), Math.round((0.12 + 2 * 0.24) * 1000) + 120);
    }
}

function crucCloseCompletion() {
    const modal = document.getElementById('cruc-completion-modal');
    if (modal) modal.classList.remove('active');
}

/* ── COMPARTIR RESULTADO (estilo Wordle) ────── */

function crucShare() {
    if (!crucData) return;
    const total  = crucData.words.length;
    const solved = crucSolvedWords.size;
    const est    = crucEstrellasDe(solved);
    const d      = crucDivisionDe(crucNivel);
    const text =
        `El Crucigrama FutbolHUB · Nivel ${crucNivel} (${d.nombre})
` +
        `${'★'.repeat(est)}${'☆'.repeat(3 - est)}  ${solved}/${total} en ${crucFormatoTiempo(crucSegundos)}
` +
        `${crucEstrellasTotales()} estrellas en total
` +
        window.location.origin + window.location.pathname;
    crucDoShare(text, document.getElementById('cruc-share-btn'));
}

function crucDoShare(text, btn) {
    const feedback = () => {
        if (!btn) return;
        const orig = btn.textContent;
        btn.textContent = '✓ ¡Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    };
    if (navigator.share) {
        navigator.share({ text }).catch(() => {});
    } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(feedback).catch(() => {});
    } else {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            feedback();
        } catch {}
    }
}

/* Cuánto falta para la medianoche DE MADRID, que es cuando cambia el
   crucigrama (crucTodayMadrid manda). Con la medianoche del dispositivo, a
   quien jugara desde otro huso la cuenta atrás le llegaba a cero y seguía
   viendo el mismo crucigrama, o cambiaba con horas de adelanto. */

// ── FOCO MÓVIL ───────────────────────────────
// El input oculto global se crea en DOMContentLoaded (al final del archivo).
// Esta función lo enfoca para abrir el teclado nativo en móvil (tap bar).

function crucFocusMobile() {
    const inp = document.getElementById('cruc-mobile-input');
    if (inp) inp.focus({ preventScroll: true });
}
// ── INTEGRACIÓN CON core.js + SETUP GLOBAL ──
document.addEventListener('DOMContentLoaded', () => {

    // Input oculto global (igual que en app.js para el Once)
    //    Se crea UNA SOLA VEZ y persiste toda la sesión.
    const mobileInput = document.createElement('input');
    mobileInput.id = 'cruc-mobile-input';
    mobileInput.type = 'text';
    mobileInput.setAttribute('autocomplete', 'off');
    mobileInput.setAttribute('autocorrect', 'off');
    mobileInput.setAttribute('autocapitalize', 'characters');
    mobileInput.setAttribute('spellcheck', 'false');
    mobileInput.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:none;outline:none;background:transparent;color:transparent;font-size:16px;pointer-events:none;z-index:-1;';
    document.body.appendChild(mobileInput);

    // Evento 'input': teclado nativo móvil (tap bar → focus → escribir)
    mobileInput.addEventListener('input', () => {
        const val = mobileInput.value;
        mobileInput.value = '';
        if (!val) return;
        for (const ch of val) {
            if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]$/i.test(ch)) crucHandleKey(ch.toUpperCase());
        }
    });

    // Backspace en móvil
    mobileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') { e.preventDefault(); mobileInput.value = ''; crucHandleKey('Delete'); }
        else if (e.key === 'Tab')  { e.preventDefault(); crucHandleKey('Tab'); }
    });

    // 3. Teclado físico desktop: igual que en app.js
    //    Solo actúa si el crucigrama está visible Y no es móvil
    document.addEventListener('keydown', (e) => {
        const screen = document.getElementById('crucigrama-screen');
        if (!screen || screen.style.display === 'none') return;

        // En móvil, el input oculto lo maneja todo
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 600) return;

        const modal = document.getElementById('cruc-completion-modal');
        if (modal && modal.classList.contains('active')) return;

        if (e.key === 'Backspace')                          { e.preventDefault(); crucHandleKey('Delete'); }
        else if (e.key === 'Tab')                           { e.preventDefault(); crucHandleKey('Tab'); }
        else if (e.key.startsWith('Arrow'))                 { e.preventDefault(); crucHandleKey(e.key); }
        else if (/^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]$/i.test(e.key)) { e.preventDefault(); crucHandleKey(e.key.toUpperCase()); }
    });
});

// ── INIT AL CARGAR ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    /* Rescate para js/pantalla-viva.js. Aquí hace especial falta: el <body>
       de esta página es prácticamente un solo <div> que el juego reemplaza
       entero, así que si ese reemplazo se queda a medias no hay ninguna otra
       pantalla que encender — y sin esto el rescate genérico solo podría
       ofrecer su panel. */
    window.FHPantallaViva = window.FHPantallaViva || {};
    window.FHPantallaViva.rescate = () => {
        crucFatal('No he podido montar el crucigrama.<br>Prueba a recargar la página.');
    };
    openCrucigrama();
});

/* Volver a la app tras tenerla en segundo plano es EL momento en que esto
   fallaba: iOS suspende la red y la primera peticion al volver muere aunque
   la cobertura sea perfecta. Si el arranque se cayo por eso, se rehace solo
   en vez de dejar al jugador delante de un error sin salida. */
function crucReintentarArranque() {
    if (!crucArranqueIncompleto || crucReintentando) return;
    crucReintentando = true;
    crucLoading('REINTENTANDO...');
    Promise.resolve().then(crucStart)
        .catch(e => { console.error('[Crucigrama] el reintento de arranque fallo', e); })
        .then(() => { crucReintentando = false; });
}
if (window.FHRed && FHRed.alRecuperar) FHRed.alRecuperar(crucReintentarArranque);
else {
    window.addEventListener('pageshow', crucReintentarArranque);
    window.addEventListener('online', crucReintentarArranque);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) crucReintentarArranque();
    });
}
