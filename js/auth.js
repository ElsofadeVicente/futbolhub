/* =============================================
   AUTH.JS — Sesión de usuario con Supabase Auth
   FutbolHUB

   Cargar SIEMPRE después de js/supabase-config.js (SUPABASE_URL /
   SUPABASE_KEY). La librería supabase-js YA NO se carga desde el HTML: la
   trae este archivo, y solo cuando hace falta (ver abajo).

   Las contraseñas nunca pasan por nuestro código más allá del formulario:
   viajan por HTTPS a Supabase Auth, que las guarda hasheadas (bcrypt) en su
   tabla interna auth.users. Aquí solo manejamos la sesión (JWT + refresh
   token), que supabase-js persiste en localStorage y renueva sola. Al ser
   todo el mismo origen, la sesión vale para el hub y para todos los juegos.

   ── CARGA PEREZOSA DE supabase-js (2026-08-31) ────────────────────────────
   `js/vendor/supabase-js.min.js` son 208 KB que las 15 páginas cargaban
   SIEMPRE, de forma síncrona, al final del <body>. Y el visitante SIN SESIÓN
   —que es la mayoría— no los necesita para absolutamente nada: se descargaban,
   se parseaban y se creaba un cliente entero para acabar contestando "no hay
   sesión".

   Ahora la librería se pide con <script> solo en tres situaciones:

     1. Hay una sesión guardada en localStorage (`sb-<ref>-auth-token`).
     2. La URL es la vuelta de un login (PKCE `?code=`, `#access_token=`,
        el enlace de recuperación de contraseña, o un error de OAuth).
        Esto NO puede ser perezoso: `detectSessionInUrl` tiene que procesar
        esa vuelta al cargar, o el login con Google se pierde.
     3. Alguien llama a algo que necesita el cliente de verdad: entrar,
        registrarse, leer el perfil, subir un avatar... Todas las funciones
        de aquí abajo hacen `await ready()` antes de tocar nada.

   Lo que cambia de cara al resto del código:
     · `FHAuth.ready()` → Promise que resuelve con el cliente ya creado. Es
       lo que tienen que usar `js/liga.js`, `js/ranked.js`,
       `js/progress-sync.js` y `js/profile-widget.js`.
     · `FHAuth.client` sigue existiendo, pero es un GETTER y vale `null`
       mientras la librería no se haya cargado. No usarlo sin `ready()`.
     · `getSession()` tiene un atajo: si no hay sesión guardada ni vuelta de
       login, devuelve `null` SIN cargar nada. Para el visitante anónimo la
       identidad se resuelve de inmediato, más rápido que antes.
     · `onChange(cb)` se puede llamar antes de que exista el cliente: los
       callbacks se encolan y se enganchan en cuanto se crea. Como
       `onAuthStateChange` emite un evento inicial al suscribirse, un
       callback tardío no se pierde nada.
   ============================================= */
(function () {
    'use strict';

    if (typeof SUPABASE_URL === 'undefined') {
        console.error('[FHAuth] Falta js/supabase-config.js');
        return;
    }

    /* Ruta ABSOLUTA: este archivo lo cargan tanto la portada (./js/...) como
       los 14 juegos (../js/...), y el <script> lo inyectamos nosotros. */
    const LIB_URL = '/js/vendor/supabase-js.min.js';

    let _libPromise = null;
    function cargarLib() {
        if (typeof supabase !== 'undefined') return Promise.resolve();
        if (_libPromise) return _libPromise;
        _libPromise = new Promise(function (resolve, reject) {
            const s = document.createElement('script');
            s.src = LIB_URL;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('No se pudo cargar supabase-js')); };
            (document.head || document.documentElement).appendChild(s);
        });
        return _libPromise;
    }

    let _client = null;
    let _readyPromise = null;
    const _pendientesOnChange = [];

    /* Promise<client>. Idempotente: la librería se pide una sola vez. */
    function ready() {
        if (_client) return Promise.resolve(_client);
        if (!_readyPromise) {
            _readyPromise = cargarLib().then(function () {
                _client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true,   // procesa la vuelta del login con Google
                        flowType: 'pkce',
                    },
                });
                while (_pendientesOnChange.length) _suscribir(_pendientesOnChange.shift());
                return _client;
            });
        }
        return _readyPromise;
    }

    /* ¿Hay una sesión guardada? supabase-js la escribe en localStorage bajo
       `sb-<ref del proyecto>-auth-token` (comprobado en el bundle vendorizado:
       la clave se construye como `sb-${hostname.split('.')[0]}-auth-token`).

       La comprobación es DELIBERADAMENTE ancha —cualquier clave `sb-…` que
       hable de `auth-token`, incluidos los trozos `.0`/`.1` en los que la
       librería parte un token largo— porque el precio de los dos errores no
       es el mismo: un falso positivo solo carga 208 KB de más una vez,
       mientras que un falso negativo dejaría a alguien con sesión viéndose
       como anónimo. Si algún día supabase-js cambia el nombre de la clave,
       esto lo absorbe.

       Si localStorage está bloqueado (modo privado de Safari, cookies
       denegadas) se devuelve true: mejor cargar de más que romper el login. */
    function haySesionGuardada() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || k.slice(0, 3) !== 'sb-' || k.indexOf('auth-token') === -1) continue;
                const v = localStorage.getItem(k);
                if (v && v.length > 2) return true;
            }
            return false;
        } catch (e) {
            return true;
        }
    }

    /* ¿Venimos de un login / de un enlace de correo? Aquí NO se puede ser
       perezoso: detectSessionInUrl tiene que procesar la vuelta al cargar.
         · PKCE (Google, el flujo que usamos): ?code=...
         · Flujo implícito y enlaces de correo: #access_token=... / #type=...
         · Errores de OAuth: ?error=... / #error=...
       Ninguno de los parámetros propios de la web (sala, modo, dia) choca
       con estos nombres. */
    function esVueltaDeLogin() {
        try {
            const q = location.search || '';
            const h = location.hash || '';
            return /[?&](code|error|error_description)=/.test(q) ||
                   /[#&](access_token|refresh_token|error|type)=/.test(h);
        } catch (e) {
            return false;
        }
    }

    function hayQueCargarYa() {
        return haySesionGuardada() || esVueltaDeLogin();
    }

    const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

    /* Perfil cacheado de la sesión actual (evita repetir la consulta) */
    let cachedProfile = null;
    let cachedProfileFor = null;

    /* ── Helpers ── */

    function normalizeUsername(name) {
        return String(name || '').trim().toLowerCase();
    }

    function validateUsername(name) {
        const u = normalizeUsername(name);
        if (!USERNAME_RE.test(u)) {
            return { ok: false, error: 'El nombre debe tener 3-20 caracteres: letras minúsculas, números, "." o "_".' };
        }
        return { ok: true, username: u };
    }

    /* Mensajes de error de Supabase → castellano */
    function friendlyError(err) {
        const msg = (err && err.message || '').toLowerCase();
        if (msg.includes('invalid login credentials'))       return 'Correo o contraseña incorrectos.';
        if (msg.includes('email not confirmed'))             return 'Tienes que confirmar tu correo antes de entrar. Revisa tu bandeja de entrada.';
        if (msg.includes('user already registered'))         return 'Ya existe una cuenta con ese correo.';
        if (msg.includes('password should be at least'))     return 'La contraseña es demasiado corta.';
        if (msg.includes('is invalid') && msg.includes('email')) return 'Ese correo no parece válido.';
        if (msg.includes('rate limit') || msg.includes('too many')) return 'Demasiados intentos. Espera un momento y vuelve a probar.';
        if (msg.includes('failed to fetch'))                 return 'Sin conexión. Comprueba tu internet.';
        return (err && err.message) || 'Algo ha fallado. Inténtalo de nuevo.';
    }

    /* ── Sesión ── */

    async function getSession() {
        /* El atajo que hace que todo esto valga la pena: sin sesión guardada
           y sin vuelta de login no hay nada que consultar, así que se
           contesta que no hay sesión sin descargar la librería. En cuanto el
           cliente existe (porque alguien entró) se le pregunta a él. */
        if (!_client && !hayQueCargarYa()) return null;
        const c = await ready();
        const { data } = await c.auth.getSession();
        return data.session || null;
    }

    async function getProfile(force) {
        const session = await getSession();
        if (!session) { cachedProfile = null; cachedProfileFor = null; return null; }
        if (!force && cachedProfile && cachedProfileFor === session.user.id) return cachedProfile;
        const client = await ready();
        let { data, error } = await client
            .from('profiles').select('id, username, avatar_url, username_changed, created_at').eq('id', session.user.id).maybeSingle();
        if (error && /username_changed/i.test(error.message || '')) {
            // La columna aún no existe (falta ejecutar setup_perfiles_v2.sql):
            // degradamos con elegancia para no romper la carga del perfil.
            ({ data, error } = await client
                .from('profiles').select('id, username, avatar_url, created_at').eq('id', session.user.id).maybeSingle());
            if (data) data.username_changed = false;
        }
        if (error) { console.error('[FHAuth] Error leyendo perfil:', error); return null; }
        cachedProfile = data;
        cachedProfileFor = session.user.id;
        return data;
    }

    function _suscribir(cb) {
        _client.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
                cachedProfile = null; cachedProfileFor = null;
            }
            cb(event, session);
        });
    }

    /* cb(eventName, session) — también se dispara una vez al suscribirse.
       Se puede llamar antes de que exista el cliente: queda encolado y se
       engancha en cuanto se cree. Un callback que llega tarde no se pierde
       nada, porque onAuthStateChange emite un evento inicial al suscribirse. */
    function onChange(cb) {
        if (_client) _suscribir(cb);
        else _pendientesOnChange.push(cb);
    }

    /* ── Registro / acceso ── */

    async function isUsernameFree(name) {
        const u = normalizeUsername(name);
        const client = await ready();
        const { data, error } = await client
            .from('profiles').select('id').eq('username', u).maybeSingle();
        if (error) throw new Error(friendlyError(error));
        return !data;
    }

    async function signUp(email, password, username) {
        const v = validateUsername(username);
        if (!v.ok) return { ok: false, error: v.error };
        try {
            if (!(await isUsernameFree(v.username))) {
                return { ok: false, error: 'Ese nombre de usuario ya está cogido.' };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
        const client = await ready();
        const { data, error } = await client.auth.signUp({
            email: String(email || '').trim(),
            password,
            options: {
                data: { username: v.username },      // el trigger lo copia a profiles
                emailRedirectTo: location.href,      // el enlace de confirmación vuelve aquí
            },
        });
        if (error) return { ok: false, error: friendlyError(error) };
        // Con "Confirm email" activado no hay sesión todavía: toca revisar el correo
        return { ok: true, needsConfirmation: !data.session };
    }

    async function signIn(email, password) {
        const client = await ready();
        const { error } = await client.auth.signInWithPassword({
            email: String(email || '').trim(),
            password,
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true };
    }

    async function signInWithGoogle() {
        const client = await ready();
        const { error } = await client.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: location.href },
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true }; // el navegador se va a Google y vuelve
    }

    async function resetPassword(email) {
        const client = await ready();
        const { error } = await client.auth.resetPasswordForEmail(String(email || '').trim(), {
            redirectTo: location.href,
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true };
    }

    async function updatePassword(newPassword) {
        const client = await ready();
        const { error } = await client.auth.updateUser({ password: newPassword });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true };
    }

    /* Elegir username después del primer login con Google */
    async function setUsername(name) {
        const v = validateUsername(name);
        if (!v.ok) return { ok: false, error: v.error };
        const session = await getSession();
        if (!session) return { ok: false, error: 'No has iniciado sesión.' };
        const client = await ready();
        const { error } = await client
            .from('profiles').update({ username: v.username }).eq('id', session.user.id);
        if (error) {
            if ((error.code === '23505') || /duplicate|unique/i.test(error.message)) {
                return { ok: false, error: 'Ese nombre de usuario ya está cogido.' };
            }
            return { ok: false, error: friendlyError(error) };
        }
        cachedProfile = null;
        return { ok: true };
    }

    /* Cambiar el nombre de usuario. Solo se permite UNA vez: la base de
       datos lo fuerza con un trigger; aquí damos el mensaje amable. */
    async function changeUsername(name) {
        const v = validateUsername(name);
        if (!v.ok) return { ok: false, error: v.error };
        const session = await getSession();
        if (!session) return { ok: false, error: 'No has iniciado sesión.' };

        const profile = await getProfile();
        if (profile && profile.username === v.username) {
            return { ok: false, error: 'Ese ya es tu nombre de usuario.' };
        }
        if (profile && profile.username_changed) {
            return { ok: false, error: 'Ya has usado tu único cambio de nombre.' };
        }
        try {
            if (!(await isUsernameFree(v.username))) {
                return { ok: false, error: 'Ese nombre de usuario ya está cogido.' };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }

        const client = await ready();
        const { error } = await client
            .from('profiles').update({ username: v.username }).eq('id', session.user.id);
        if (error) {
            if (/username_change_not_allowed/i.test(error.message)) {
                return { ok: false, error: 'Ya has usado tu único cambio de nombre.' };
            }
            if ((error.code === '23505') || /duplicate|unique/i.test(error.message)) {
                return { ok: false, error: 'Ese nombre de usuario ya está cogido.' };
            }
            return { ok: false, error: friendlyError(error) };
        }
        cachedProfile = null;
        return { ok: true };
    }

    /* Subir/cambiar la foto de perfil. Guarda el archivo en el bucket
       "avatars", dentro de la carpeta del usuario (avatars/{uid}/...),
       y apunta profiles.avatar_url a su URL pública. */
    const MAX_AVATAR_BYTES = 4 * 1024 * 1024; // 4 MB
    async function uploadAvatar(file) {
        const session = await getSession();
        if (!session) return { ok: false, error: 'No has iniciado sesión.' };
        if (!file) return { ok: false, error: 'No has elegido ninguna imagen.' };
        if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
            return { ok: false, error: 'La foto debe ser una imagen (JPG, PNG, WEBP o GIF).' };
        }
        if (file.size > MAX_AVATAR_BYTES) {
            return { ok: false, error: 'La imagen es demasiado grande (máximo 4 MB).' };
        }
        const ext = (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        // timestamp en la ruta => cada foto es una URL nueva y no queda cacheada la vieja
        const path = `${session.user.id}/avatar_${Date.now()}.${ext}`;
        const client = await ready();
        const up = await client.storage.from('avatars').upload(path, file, {
            upsert: true,
            contentType: file.type,
            cacheControl: '3600',
        });
        if (up.error) return { ok: false, error: friendlyError(up.error) };

        const { data: pub } = client.storage.from('avatars').getPublicUrl(path);
        const { error } = await client
            .from('profiles').update({ avatar_url: pub.publicUrl }).eq('id', session.user.id);
        if (error) return { ok: false, error: friendlyError(error) };
        cachedProfile = null;
        return { ok: true, url: pub.publicUrl };
    }

    async function signOut() {
        cachedProfile = null; cachedProfileFor = null;
        /* Sin cliente y sin token guardado no hay sesión que cerrar, y cargar
           208 KB para cerrar la nada no tiene sentido. Se mira TAMBIÉN el
           token, no solo el cliente: aunque hoy no puede darse (si hay token,
           el arranque ya crea el cliente), dejarlo colgando de esa invariante
           sería un cierre de sesión silenciosamente fallido el día que
           cambie. */
        if (!_client && !haySesionGuardada()) return;
        const client = await ready();
        await client.auth.signOut();
    }

    /* ── Avatar por defecto (estilo Instagram: inicial sobre color fijo) ── */

    const AVATAR_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#7f8c8d', '#2c3e50'];

    function defaultAvatar(username) {
        const name = normalizeUsername(username) || '?';
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
        return {
            letter: name.charAt(0).toUpperCase(),
            color: AVATAR_COLORS[hash % AVATAR_COLORS.length],
        };
    }

    /* ── Identidad para los juegos (nombre público + foto de perfil) ──
       Los juegos multijugador usan esto para: si hay sesión, no pedir el
       nombre (usar el username) y mostrar la foto en vez de la inicial.
       Si NO hay sesión, identity() es null y cada juego sigue igual. */
    let _identity = null;             // { username, avatarUrl } | null
    let _identityResolved = false;
    const _identityCbs = [];

    function _setIdentity(profile, session) {
        _identity = (session && profile && profile.username)
            ? { username: profile.username, avatarUrl: profile.avatar_url || null }
            : null;
        _identityResolved = true;
        _identityCbs.forEach(cb => { try { cb(_identity); } catch (e) { console.error(e); } });
    }
    async function _refreshIdentity() {
        const session = await getSession();
        const profile = session ? await getProfile() : null;
        _setIdentity(profile, session);
    }
    function identity() { return _identity; }
    /* cb(identity|null): se llama ya (si está resuelta) y en cada cambio de sesión/perfil */
    function onIdentity(cb) {
        if (_identityResolved) { try { cb(_identity); } catch (e) { console.error(e); } }
        _identityCbs.push(cb);
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    /* Una foto de perfil solo es de fiar si vive en NUESTRO bucket de avatares.
       En la base, la constraint avatar_url_propio ya lo garantiza para
       profiles.avatar_url; pero en los juegos online el avatar viaja por
       Firebase (room.players[x].avatar), donde un cliente malicioso puede
       escribir CUALQUIER cadena y saltarse esa constraint. Sin este filtro,
       ese avatar se cargaría como <img src="http://tracker.evil/..."> en el
       navegador de todos los rivales: un píxel de rastreo de terceros con la
       cara (y la IP) de la víctima. Aquí solo se acepta el origen de Storage;
       cualquier otra cosa cae a la inicial, como si no hubiera foto. */
    const AVATAR_OK_RE = /^https:\/\/rssvejgdekwysiseqzkd\.supabase\.co\/storage\/v1\/object\/public\/avatars\/[^"'<>\\ ]+$/i;
    function isSafeAvatarUrl(url) {
        return typeof url === 'string' && AVATAR_OK_RE.test(url);
    }

    /* HTML para meter DENTRO del contenedor de avatar que ya tiene cada juego:
       una <img> si hay foto (y es de nuestro Storage), o la inicial del nombre. */
    function avatarInner(name, avatarUrl) {
        if (isSafeAvatarUrl(avatarUrl)) {
            /* Sin style="" aquí: La Carrera lleva CSP de bloqueo (style-src sin
               unsafe-inline) y un atributo style en el HTML la violaría — las
               propiedades van en .fh-avatar-img, en css/profile-widget.css. */
            return `<img src="${escHtml(avatarUrl)}" alt="" class="fh-avatar-img">`;
        }
        return escHtml((name || '?').charAt(0).toUpperCase());
    }

    /* Mantener la identidad al día con la sesión. La suscripción se encola
       si todavía no hay cliente, así que un login posterior (que es lo que
       crea el cliente) refresca la identidad igual que antes. */
    onChange(() => setTimeout(_refreshIdentity, 0));

    if (hayQueCargarYa()) {
        /* Hay sesión o venimos de un login: se carga ya, sin esperar a que
           nadie pregunte, para que el círculo de perfil salga cuanto antes. */
        _refreshIdentity();
    } else {
        /* Visitante anónimo: identidad resuelta de inmediato y NI UN BYTE de
           supabase-js. Los onIdentity() que se registren después reciben
           null al vuelo, igual que antes recibían null tras cargar 208 KB. */
        _setIdentity(null, null);

        /* Entrar en OTRA pestaña. Antes esto se arreglaba solo: supabase-js
           estaba cargado en todas y se enteraba por el evento 'storage'. Sin
           cliente no hay quien escuche, así que escuchamos nosotros: en
           cuanto aparece el token, se carga la librería y la identidad se
           refresca. Sin esto, una pestaña abierta de antes se quedaría
           mostrándote como anónimo hasta recargarla. */
        window.addEventListener('storage', function (e) {
            if (_client) return;
            const k = e && e.key;
            if (!k || k.slice(0, 3) !== 'sb-' || k.indexOf('auth-token') === -1) return;
            if (!e.newValue) return;      // cierre de sesión: ya estamos anónimos
            _refreshIdentity();
        });
    }

    /* ── API pública ── */
    window.FHAuth = {
        /* OJO: `client` vale null mientras supabase-js no se haya cargado.
           Para usarlo, `await FHAuth.ready()`. Se conserva como getter
           porque hay código que lo lee DESPUÉS de un await que ya garantiza
           que existe. */
        get client() { return _client; },
        ready,
        getSession,
        getProfile,
        onChange,
        signUp,
        signIn,
        signInWithGoogle,
        resetPassword,
        updatePassword,
        setUsername,
        changeUsername,
        uploadAvatar,
        isUsernameFree,
        validateUsername,
        signOut,
        defaultAvatar,
        identity,
        onIdentity,
        avatarInner,
        isSafeAvatarUrl,
        escHtml,
    };
})();
