/* =============================================
   AUTH.JS — Sesión de usuario con Supabase Auth
   QUIÉN COÑO FALTA

   Cargar SIEMPRE después de:
     js/vendor/supabase-js.min.js  (librería oficial, UMD)
     js/supabase-config.js         (SUPABASE_URL / SUPABASE_KEY)

   Las contraseñas nunca pasan por nuestro código más allá del
   formulario: viajan por HTTPS a Supabase Auth, que las guarda
   hasheadas (bcrypt) en su tabla interna auth.users. Aquí solo
   manejamos la sesión (JWT + refresh token), que supabase-js
   persiste en localStorage y renueva sola. Al ser todo el mismo
   origen, la sesión vale para el hub y para todos los juegos.
   ============================================= */
(function () {
    'use strict';

    if (typeof supabase === 'undefined' || typeof SUPABASE_URL === 'undefined') {
        console.error('[FHAuth] Falta supabase-js o supabase-config.js');
        return;
    }

    const client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,   // procesa la vuelta del login con Google
            flowType: 'pkce',
        },
    });

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
        const { data } = await client.auth.getSession();
        return data.session || null;
    }

    async function getProfile(force) {
        const session = await getSession();
        if (!session) { cachedProfile = null; cachedProfileFor = null; return null; }
        if (!force && cachedProfile && cachedProfileFor === session.user.id) return cachedProfile;
        let { data, error } = await client
            .from('profiles').select('id, username, avatar_url, username_changed').eq('id', session.user.id).maybeSingle();
        if (error && /username_changed/i.test(error.message || '')) {
            // La columna aún no existe (falta ejecutar setup_perfiles_v2.sql):
            // degradamos con elegancia para no romper la carga del perfil.
            ({ data, error } = await client
                .from('profiles').select('id, username, avatar_url').eq('id', session.user.id).maybeSingle());
            if (data) data.username_changed = false;
        }
        if (error) { console.error('[FHAuth] Error leyendo perfil:', error); return null; }
        cachedProfile = data;
        cachedProfileFor = session.user.id;
        return data;
    }

    /* cb(eventName, session) — también se dispara una vez al cargar */
    function onChange(cb) {
        client.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
                cachedProfile = null; cachedProfileFor = null;
            }
            cb(event, session);
        });
    }

    /* ── Registro / acceso ── */

    async function isUsernameFree(name) {
        const u = normalizeUsername(name);
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
        const { error } = await client.auth.signInWithPassword({
            email: String(email || '').trim(),
            password,
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true };
    }

    async function signInWithGoogle() {
        const { error } = await client.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: location.href },
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true }; // el navegador se va a Google y vuelve
    }

    async function resetPassword(email) {
        const { error } = await client.auth.resetPasswordForEmail(String(email || '').trim(), {
            redirectTo: location.href,
        });
        if (error) return { ok: false, error: friendlyError(error) };
        return { ok: true };
    }

    async function updatePassword(newPassword) {
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
    /* HTML para meter DENTRO del contenedor de avatar que ya tiene cada juego:
       una <img> si hay foto, o la inicial del nombre si no. */
    function avatarInner(name, avatarUrl) {
        if (avatarUrl) {
            return `<img src="${escHtml(avatarUrl)}" alt="" class="fh-avatar-img" ` +
                   `style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;">`;
        }
        return escHtml((name || '?').charAt(0).toUpperCase());
    }

    // Mantener la identidad al día con la sesión (y resolverla al cargar)
    onChange(() => setTimeout(_refreshIdentity, 0));
    _refreshIdentity();

    /* ── API pública ── */
    window.FHAuth = {
        client,
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
        escHtml,
    };
})();
