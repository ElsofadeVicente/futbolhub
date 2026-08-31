/* =============================================
   PROFILE-WIDGET.JS — Círculo de perfil (arriba dcha.)
   QUIÉN COÑO FALTA

   Se autoinyecta en cualquier página: basta con incluir
   css/profile-widget.css + este script (después de auth.js).

   Estados:
   - Sin sesión  → círculo neutro → desplegable con "Iniciar sesión"
                   → modal con Entrar / Crear cuenta / Google / olvidé
   - Con sesión  → avatar (foto o inicial) → desplegable con
                   Perfil / Estadísticas / Ajustes (con Cerrar sesión)
   - Primer login con Google sin username → modal "elige tu nombre"
   - Vuelta del enlace "olvidé mi contraseña" → modal de nueva contraseña
   ============================================= */
(function () {
    'use strict';

    if (!window.FHAuth) { console.error('[pw] Falta auth.js'); return; }

    /* ───────────────────────── DOM base ───────────────────────── */

    const root = document.createElement('div');
    root.className = 'pw-root';
    root.innerHTML = `
      <button class="pw-circle" type="button" aria-label="Perfil" aria-expanded="false">
        <span class="pw-circle-inner"></span>
      </button>
      <div class="pw-dropdown" hidden></div>
    `;

    const overlay = document.createElement('div');
    overlay.className = 'pw-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `<div class="pw-modal" role="dialog" aria-modal="true"></div>`;

    const circleBtn = root.querySelector('.pw-circle');
    const circleInner = root.querySelector('.pw-circle-inner');
    const dropdown = root.querySelector('.pw-dropdown');
    const modal = overlay.querySelector('.pw-modal');

    let profile = null;      // fila de profiles (o null sin sesión)
    let session = null;

    /* ───────────────────────── Utilidades ───────────────────────── */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const USER_ICON = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="8.2" r="3.6"/>
        <path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4"/>
      </svg>`;

    const GOOGLE_ICON = `
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C41 35.4 44 30.2 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`;

    /* Iconos del bloque de identidad en Perfil: cámara sobre el avatar
       (cambiar foto) y lápiz junto al nombre (cambiar nombre de usuario). */
    const CAMERA_ICON = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 8h3l1.6-2.2a1 1 0 0 1 .8-.4h5.2a1 1 0 0 1 .8.4L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>
        <circle cx="12" cy="13.4" r="3.3"/>
      </svg>`;

    const PENCIL_ICON = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16.6 3.6a2.1 2.1 0 0 1 3 3L7.5 18.7l-4.2 1 1-4.2Z"/>
      </svg>`;

    function avatarHTML(size) {
        if (profile && profile.avatar_url) {
            return `<img class="pw-avatar-img" src="${esc(profile.avatar_url)}" alt="">`;
        }
        if (session) {
            const seed = (profile && profile.username) ||
                         (session.user && session.user.email) || '?';
            const av = FHAuth.defaultAvatar(seed);
            /* Nada de style="background:..." aquí: /la-carrera/ tiene una CSP
               enforced sin 'unsafe-inline' en style-src (ver CLAUDE.md, "SEO"),
               y un atributo style="" en el HTML la viola. El color va como
               data-attribute y se aplica luego por propiedad JS
               (applyAvatarColors), que la CSP no cubre. */
            return `<span class="pw-avatar-letter" data-avatar-color="${esc(av.color)}">${esc(av.letter)}</span>`;
        }
        return USER_ICON;
    }

    /* El color del avatar-letra llega como data-attribute (ver avatarHTML) y
       se pinta aquí por asignación de propiedad (`el.style.background = …`),
       no por atributo style="" ni por cssText: la CSP de style-src solo
       restringe esas dos formas, no la API de CSSOM. Llamar tras CADA
       innerHTML que pueda contener un .pw-avatar-letter. */
    function applyAvatarColors(root) {
        root.querySelectorAll('[data-avatar-color]').forEach(el => {
            el.style.background = el.dataset.avatarColor;
        });
    }

    function displayName() {
        if (profile && profile.username) return '@' + profile.username;
        if (session && session.user) return session.user.email || 'Tu cuenta';
        return '';
    }

    /* ─────────────────────── Círculo + desplegable ─────────────────────── */

    function renderCircle() {
        circleInner.innerHTML = avatarHTML();
        applyAvatarColors(circleInner);
        circleBtn.classList.toggle('pw-logged', !!session);
    }

    function renderDropdown() {
        if (!session) {
            /* Sin sesión no hay "Ajustes" donde meter el diseño, y elegirlo no
               necesita cuenta (se guarda en el navegador): va suelto aquí. */
            dropdown.innerHTML = `
              <button class="pw-login-cta" type="button" data-action="open-login">Iniciar sesión</button>
              <div class="pw-drop-note">Guarda tus estadísticas en todos los juegos</div>
              ${window.FHTheme ? `<div class="pw-drop-line"></div>
              <button class="pw-item" type="button" data-action="diseno">Diseño de la web</button>` : ''}`;
        } else {
            dropdown.innerHTML = `
              <div class="pw-drop-head">
                <span class="pw-drop-avatar">${avatarHTML()}</span>
                <div class="pw-drop-id">
                  <div class="pw-drop-name">${esc(displayName())}</div>
                  <div class="pw-drop-mail">${esc(session.user.email || '')}</div>
                </div>
              </div>
              <button class="pw-item" type="button" data-action="perfil">Perfil</button>
              <button class="pw-item" type="button" data-action="estadisticas">Estadísticas</button>
              <button class="pw-item" type="button" data-action="ajustes">Ajustes</button>`;
        }
        applyAvatarColors(dropdown);
    }

    function toggleDropdown(force) {
        const show = force != null ? force : dropdown.hidden;
        dropdown.hidden = !show;
        circleBtn.setAttribute('aria-expanded', String(show));
        if (show) renderDropdown();
    }

    /* ─────────────────────────── Modal ─────────────────────────── */

    function openModal(html) {
        modal.innerHTML = `<button class="pw-close" type="button" aria-label="Cerrar">×</button>` + html;
        applyAvatarColors(modal);
        overlay.hidden = false;
        document.body.classList.add('pw-no-scroll');
        const first = modal.querySelector('input');
        if (first) setTimeout(() => first.focus(), 50);
    }

    function closeModal() {
        overlay.hidden = true;
        modal.innerHTML = '';
        document.body.classList.remove('pw-no-scroll');
    }

    function setMsg(kind, text) {
        const box = modal.querySelector('.pw-msg');
        if (!box) return;
        box.className = 'pw-msg' + (kind ? ' pw-msg--' + kind : '');
        box.textContent = text || '';
    }

    function setBusy(busy) {
        modal.querySelectorAll('button, input').forEach(el => { el.disabled = busy; });
        const closeBtn = modal.querySelector('.pw-close');
        if (closeBtn) closeBtn.disabled = false;
    }

    /* ── Vistas del modal ── */

    function loginView(tab) {
        const entrar = tab !== 'signup';
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <div class="pw-tabs">
            <button type="button" class="pw-tab ${entrar ? 'pw-tab--on' : ''}" data-action="tab-login">Entrar</button>
            <button type="button" class="pw-tab ${entrar ? '' : 'pw-tab--on'}" data-action="tab-signup">Crear cuenta</button>
          </div>
          <form class="pw-form" data-form="${entrar ? 'login' : 'signup'}">
            ${entrar ? '' : `
              <label class="pw-label">Nombre de usuario
                <input class="pw-input" name="username" type="text" autocomplete="username"
                       maxlength="20" placeholder="p. ej. sofa_vicente" required>
                <span class="pw-hint">3-20 caracteres: minúsculas, números, "." y "_". Será público y único.</span>
              </label>`}
            <label class="pw-label">Correo electrónico
              <input class="pw-input" name="email" type="email" autocomplete="email" required>
            </label>
            <label class="pw-label">Contraseña
              <input class="pw-input" name="password" type="password"
                     autocomplete="${entrar ? 'current-password' : 'new-password'}"
                     minlength="8" required>
              ${entrar ? '' : '<span class="pw-hint">Mínimo 8 caracteres.</span>'}
            </label>
            <div class="pw-msg"></div>
            <button class="pw-primary" type="submit">${entrar ? 'Entrar' : 'Crear cuenta'}</button>
          </form>
          ${entrar ? `<button class="pw-linkbtn" type="button" data-action="forgot">¿Olvidaste tu contraseña?</button>` : ''}
          <div class="pw-sep"><span>o</span></div>
          <button class="pw-google" type="button" data-action="google">${GOOGLE_ICON} Continuar con Google</button>
        `);
    }

    function forgotView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Recuperar contraseña</h3>
          <p class="pw-text">Te enviamos un enlace a tu correo para crear una contraseña nueva.</p>
          <form class="pw-form" data-form="forgot">
            <label class="pw-label">Correo electrónico
              <input class="pw-input" name="email" type="email" autocomplete="email" required>
            </label>
            <div class="pw-msg"></div>
            <button class="pw-primary" type="submit">Enviar enlace</button>
          </form>
          <button class="pw-linkbtn" type="button" data-action="open-login">← Volver</button>
        `);
    }

    function chooseUsernameView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Elige tu nombre de usuario</h3>
          <p class="pw-text">Es la última cosa que falta para terminar tu cuenta. Será público y único.</p>
          <form class="pw-form" data-form="choose-username">
            <label class="pw-label">Nombre de usuario
              <input class="pw-input" name="username" type="text" maxlength="20"
                     placeholder="p. ej. sofa_vicente" required>
              <span class="pw-hint">3-20 caracteres: minúsculas, números, "." y "_".</span>
            </label>
            <div class="pw-msg"></div>
            <button class="pw-primary" type="submit">Guardar</button>
          </form>
        `);
        // Este modal no se puede cerrar sin elegir nombre (solo cerrando sesión)
        const closeBtn = modal.querySelector('.pw-close');
        closeBtn.textContent = '';
        closeBtn.setAttribute('aria-label', 'Cerrar sesión');
        closeBtn.classList.add('pw-close--text');
        closeBtn.textContent = 'Salir';
        closeBtn.dataset.action = 'logout';
    }

    function newPasswordView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Nueva contraseña</h3>
          <form class="pw-form" data-form="new-password">
            <label class="pw-label">Contraseña nueva
              <input class="pw-input" name="password" type="password" autocomplete="new-password" minlength="8" required>
              <span class="pw-hint">Mínimo 8 caracteres.</span>
            </label>
            <div class="pw-msg"></div>
            <button class="pw-primary" type="submit">Guardar contraseña</button>
          </form>
        `);
    }

    /* ── Perfil: identidad de la cuenta + resumen + tu división en Liga ──
       Estadísticas (siguiente vista) ya enseña lo jugado hoy y la racha de
       cada juego, así que aquí no se repite esa lista: solo identidad,
       un resumen agregado y la Liga, con un botón que lleva a Estadísticas.

       La Liga (ver CLAUDE.md, "Liga competitiva") hoy solo existe en El
       Estadio, y js/liga.js solo se carga en esa página — el perfil se abre
       desde cualquiera de las 14, así que se pide con la MISMA RPC
       (`liga_panel`) directamente contra el cliente de auth.js en vez de depender
       de que liga.js esté cargado. Los nombres de tramo se duplican aquí
       (8 líneas, liga.js los tiene con logo e info completa) porque
       liga.js no siempre está disponible; si cambian allí, cambiar aquí. */
    const LIGA_TRAMOS = [
        'Tercera División', 'Segunda B', 'Segunda División', 'Primera División',
        'Conference League', 'Europa League', 'Champions League', 'Mundial',
    ];

    function perfilView() {
        const games = (window.FHStreaks && FHStreaks.list()) || [];
        const conRacha = games.filter(g => g.streak > 0);
        const mejor = games.reduce((m, g) => Math.max(m, g.streak), 0);
        const changed = !!(profile && profile.username_changed);

        const desde = profile && profile.created_at
            ? new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(profile.created_at))
            : null;

        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>

          <div class="pw-id-block">
            <button class="pw-avatar-edit" type="button" data-action="change-photo" aria-label="Cambiar foto de perfil">
              <span class="pw-drop-avatar pw-avatar-xl">${avatarHTML()}</span>
              <span class="pw-avatar-edit-badge" aria-hidden="true">${CAMERA_ICON}</span>
            </button>
            <input class="pw-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            <div class="pw-drop-id">
              <div class="pw-id-name-row">
                <div class="pw-drop-name">${esc(displayName())}</div>
                ${changed ? '' : `<button class="pw-icon-btn" type="button" data-action="change-username" aria-label="Cambiar nombre de usuario">${PENCIL_ICON}</button>`}
              </div>
              <div class="pw-drop-mail">${esc(session && session.user.email || '')}</div>
              ${desde ? `<div class="pw-drop-mail">Jugando desde el ${esc(desde)}</div>` : ''}
            </div>
          </div>
          <p class="pw-hint pw-hint--indent">${changed
            ? 'Ya has usado tu único cambio de nombre de usuario.'
            : 'Toca la foto para cambiarla, o el lápiz para cambiar tu nombre (una sola vez).'}</p>

          <div class="pw-field-label">Resumen</div>
          ${games.length === 0 ? `<p class="pw-text">No se han podido leer las partidas.</p>` : `
          <ul class="pw-stats-list">
            <li class="pw-stats-row"><span class="pw-stats-name">Juegos con racha viva</span><span class="pw-stats-val">${esc(conRacha.length)} de ${esc(games.length)}</span></li>
            <li class="pw-stats-row"><span class="pw-stats-name">Mejor racha</span><span class="pw-stats-val">${esc(mejor)} 🔥</span></li>
          </ul>`}

          <div class="pw-field-label">Liga competitiva</div>
          <div data-slot="liga"><p class="pw-text">Cargando…</p></div>

          <div class="pw-field-label">Palmarés</div>
          <div data-slot="ranked"><p class="pw-text">Cargando…</p></div>

          <button class="pw-secondary" type="button" data-action="estadisticas">Ver estadísticas completas</button>
        `);

        const slot = modal.querySelector('[data-slot="liga"]');
        /* Token para descartar la respuesta si el modal ya cambió de vista
           (o se cerró) antes de que vuelva la RPC — mismo problema que
           evita `_isToday` en los diarios, aquí con una petición en vuelo. */
        const token = {};
        perfilView._token = token;
        if (!session) {
            slot.innerHTML = `<p class="pw-text">Inicia sesión para tener una división en la Liga.</p>`;
            const rSlot = modal.querySelector('[data-slot="ranked"]');
            if (rSlot) rSlot.innerHTML = `<p class="pw-text">Inicia sesión para tener palmarés.</p>`;
            return;
        }
        FHAuth.ready().then(c => c.rpc('liga_panel', { p_juego: 'el-estadio' })).then(({ data, error }) => {
            if (perfilView._token !== token || !slot.isConnected) return;
            if (error || !data || data.auth === false || !Array.isArray(data.clasificacion)) {
                slot.innerHTML = `<p class="pw-text">No se ha podido cargar tu división.</p>`;
                return;
            }
            const fila = data.clasificacion.find(r => r.user_id === data.yo);
            if (!fila) {
                slot.innerHTML = `<p class="pw-text">Aún no tienes división esta semana: juega hoy en El Estadio para entrar.</p>`;
                return;
            }
            const nombre = LIGA_TRAMOS[Math.max(0, Math.min(LIGA_TRAMOS.length - 1, Number(data.tramo) || 0))];
            slot.innerHTML = `
              <ul class="pw-stats-list">
                <li class="pw-stats-row"><span class="pw-stats-name">${esc(nombre)}</span><span class="pw-stats-val">Puesto ${esc(fila.pos)} de ${esc(data.cap || data.clasificacion.length)}</span></li>
              </ul>`;
        }).catch(() => {
            if (perfilView._token !== token || !slot.isConnected) return;
            slot.innerHTML = `<p class="pw-text">No se ha podido cargar tu división.</p>`;
        });

        /* Palmarés de los modos Clasificatoria (ranked 1v1 por ELO,
           PLAN-coche-ranked.md §7). Una fila por juego con datos reales; hoy
           solo Coche tiene filas en ranked_rating, así que es lo único que
           puede salir, pero el bloque ya recorre "juegos" entero para que
           los que se añadan después aparezcan solos sin tocar esta vista.
           Igual que arriba: RPC directo contra el cliente de auth.js, no depende de
           que js/ranked.js esté cargado (el hub y muchos juegos no lo cargan). */
        const rankedSlot = modal.querySelector('[data-slot="ranked"]');
        if (rankedSlot) {
            FHAuth.ready().then(c => c.rpc('ranked_perfil', { p_user: session.user.id })).then(({ data, error }) => {
                if (perfilView._token !== token || !rankedSlot.isConnected) return;
                if (error || !data || data.auth === false || !Array.isArray(data.juegos) || !data.juegos.length) {
                    rankedSlot.innerHTML = `<p class="pw-text">Aún no has jugado ninguna Clasificatoria.</p>`;
                    return;
                }
                const NOMBRE_JUEGO = { coche: 'Coche' };
                rankedSlot.innerHTML = '<ul class="pw-stats-list">' + data.juegos.map(j => {
                    const nombreJuego = NOMBRE_JUEGO[j.juego] || j.juego;
                    const tramoMax = LIGA_TRAMOS[Math.max(0, Math.min(LIGA_TRAMOS.length - 1, Number(j.tramo_max) || 0))];
                    return `<li class="pw-stats-row">
                      <span class="pw-stats-name">${esc(nombreJuego)} — récord: ${esc(tramoMax)}</span>
                      <span class="pw-stats-val">${esc(j.elo)} ELO · ${esc(j.victorias)}V-${esc(j.derrotas)}D</span>
                    </li>`;
                }).join('') + '</ul>';
            }).catch(() => {
                if (perfilView._token !== token || !rankedSlot.isConnected) return;
                rankedSlot.innerHTML = `<p class="pw-text">No se ha podido cargar el palmarés.</p>`;
            });
        }
    }

    /* ── Estadísticas: lo jugado hoy y la racha de cada juego diario ──
       Los datos salen de FHStreaks (js/hub-streaks.js), que lee el mismo
       progreso que js/progress-sync.js mantiene igual en todos tus
       dispositivos. Por eso esta pantalla enseña lo mismo entres desde
       donde entres, que era justo lo que faltaba. */
    function estadisticasView() {
        const games = (window.FHStreaks && FHStreaks.list()) || [];
        const jugados = games.filter(g => g.today);

        const hoyHTML = games.length === 0
            ? `<p class="pw-text">No se han podido leer las partidas.</p>`
            : jugados.length === 0
                ? `<p class="pw-text">Hoy todavía no has jugado a ningún diario.</p>`
                : `<ul class="pw-stats-list">` + jugados.map(g => `
                     <li class="pw-stats-row">
                       <span class="pw-stats-name">${esc(g.label)}</span>
                       <span class="pw-stats-val pw-stats-val--${g.today.state}">
                         ${g.today.state === 'win' ? '✅' : '❌'} ${esc(g.today.detail || '')}
                       </span>
                     </li>`).join('') + `</ul>`;

        const conRacha = games.filter(g => g.streak > 0);
        const rachaHTML = conRacha.length === 0
            ? `<p class="pw-text">Aún no tienes ninguna racha viva. Gana un día y empieza a contar.</p>`
            : `<ul class="pw-stats-list">` + conRacha.map(g => `
                 <li class="pw-stats-row">
                   <span class="pw-stats-name">${esc(g.label)}</span>
                   <span class="pw-stats-val">${g.streak} 🔥</span>
                 </li>`).join('') + `</ul>`;

        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Estadísticas</h3>

          <div class="pw-field-label">Hoy · ${esc(jugados.length)} de ${esc(games.length)} jugados</div>
          ${hoyHTML}

          <div class="pw-field-label">Rachas</div>
          ${rachaHTML}

          <p class="pw-hint">Se guardan en tu cuenta: entra desde otro dispositivo y siguen aquí.</p>
        `);
    }

    /* ── Selector de diseño ──
       Dos diseños conviven: el clásico (portada tipo periódico) y el nuevo
       "Estadio". Lo único que hace elegir uno es escribir data-theme en el
       <html> (js/theme.js); el cambio se ve al momento, detrás del modal.
       Se guarda en el navegador, no en la cuenta: es una preferencia de
       cómo quieres ver la web en ESTA pantalla. */
    const THEME_INFO = {
        classic: { name: 'Clásico', tag: 'Papel de periódico' },
        v2:      { name: 'Moderno', tag: 'Noche de estadio' },
    };

    function themePickerHTML() {
        if (!window.FHTheme) return '';
        const actual = FHTheme.get();
        return `<div class="pw-themes">` + FHTheme.THEMES.map(t => {
            const info = THEME_INFO[t.id] || { name: t.name, tag: t.tag };
            const on = t.id === actual;
            return `
              <button class="pw-theme${on ? ' pw-theme--on' : ''}" type="button"
                      data-action="set-theme" data-theme-id="${esc(t.id)}"
                      aria-pressed="${on}">
                <span class="pw-theme-prev pw-theme-prev--${esc(t.id)}">
                  <i></i><i></i><i></i>
                </span>
                <span class="pw-theme-name">${esc(info.name)}</span>
                <span class="pw-theme-tag">${esc(info.tag)}</span>
              </button>`;
        }).join('') + `</div>`;
    }

    function themeNoteHTML() {
        return `<p class="pw-hint">Cambia toda la web: la portada y los 13 juegos. Se guarda en este navegador y puedes volver al clásico cuando quieras.</p>`;
    }

    function disenoView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Diseño de la web</h3>
          <p class="pw-text">Elige cómo quieres ver FutbolHUB. Puedes cambiarlo las veces que quieras.</p>
          ${themePickerHTML()}
          ${themeNoteHTML()}
        `);
    }

    function ajustesView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Ajustes</h3>

          ${window.FHTheme ? `
            <div class="pw-field-label">Diseño de la web</div>
            ${themePickerHTML()}
            ${themeNoteHTML()}` : ''}

          <p class="pw-hint">Tu foto y tu nombre de usuario se cambian desde <button class="pw-linkbtn pw-linkbtn--inline" type="button" data-action="perfil">Perfil</button>.</p>

          <div class="pw-msg"></div>
          <button class="pw-danger" type="button" data-action="logout">Cerrar sesión</button>
        `);
    }

    function changeUsernameView() {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Cambiar nombre de usuario</h3>
          <div class="pw-warn">⚠️ Solo puedes cambiar tu nombre <strong>una vez</strong>. Después ya no se podrá modificar. Asegúrate antes de guardar.</div>
          <form class="pw-form" data-form="change-username">
            <label class="pw-label">Nuevo nombre de usuario
              <input class="pw-input" name="username" type="text" maxlength="20"
                     value="${esc(profile && profile.username || '')}" required>
              <span class="pw-hint">3-20 caracteres: minúsculas, números, "." y "_".</span>
            </label>
            <div class="pw-msg"></div>
            <button class="pw-primary" type="submit">Guardar cambio definitivo</button>
          </form>
          <button class="pw-linkbtn" type="button" data-action="perfil">← Cancelar</button>
        `);
    }

    /* ─────────────────────── Envío de formularios ─────────────────────── */

    async function handleSubmit(form) {
        const kind = form.dataset.form;
        const f = new FormData(form);
        setMsg('', '');
        setBusy(true);
        try {
            if (kind === 'login') {
                const r = await FHAuth.signIn(f.get('email'), f.get('password'));
                if (!r.ok) return setMsg('error', r.error);
                closeModal();
            } else if (kind === 'signup') {
                const r = await FHAuth.signUp(f.get('email'), f.get('password'), f.get('username'));
                if (!r.ok) return setMsg('error', r.error);
                if (r.needsConfirmation) {
                    setMsg('ok', '¡Cuenta creada! Revisa tu correo y pincha el enlace de confirmación para poder entrar.');
                    form.reset();
                } else {
                    closeModal();
                }
            } else if (kind === 'forgot') {
                const r = await FHAuth.resetPassword(f.get('email'));
                if (!r.ok) return setMsg('error', r.error);
                setMsg('ok', 'Enviado. Revisa tu correo y sigue el enlace.');
            } else if (kind === 'choose-username') {
                const r = await FHAuth.setUsername(f.get('username'));
                if (!r.ok) return setMsg('error', r.error);
                profile = await FHAuth.getProfile(true);
                closeModal();
                renderCircle();
            } else if (kind === 'change-username') {
                const r = await FHAuth.changeUsername(f.get('username'));
                if (!r.ok) return setMsg('error', r.error);
                profile = await FHAuth.getProfile(true);
                renderCircle();
                setMsg('ok', 'Nombre de usuario cambiado.');
                setTimeout(perfilView, 1200);
            } else if (kind === 'new-password') {
                const r = await FHAuth.updatePassword(f.get('password'));
                if (!r.ok) return setMsg('error', r.error);
                setMsg('ok', 'Contraseña guardada. Ya puedes seguir jugando.');
                setTimeout(closeModal, 1500);
            }
        } finally {
            setBusy(false);
        }
    }

    /* ─────────────────────────── Eventos ─────────────────────────── */

    circleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown();
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.hidden && !root.contains(e.target)) toggleDropdown(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!overlay.hidden) {
            // el modal de elegir username no se cierra con Escape
            if (!modal.querySelector('[data-form="choose-username"]')) closeModal();
        } else if (!dropdown.hidden) {
            toggleDropdown(false);
        }
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay && !modal.querySelector('[data-form="choose-username"]')) closeModal();
    });

    /* Acciones por data-action (desplegable + modal) */
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        switch (action) {
            case 'open-login':   toggleDropdown(false); loginView('login'); break;
            case 'tab-login':    loginView('login'); break;
            case 'tab-signup':   loginView('signup'); break;
            case 'forgot':       forgotView(); break;
            case 'google': {
                setMsg('', '');
                const r = await FHAuth.signInWithGoogle();
                if (!r.ok) setMsg('error', r.error);
                break;
            }
            case 'perfil':       toggleDropdown(false); perfilView(); break;
            case 'estadisticas': toggleDropdown(false); estadisticasView(); break;
            case 'ajustes':      toggleDropdown(false); ajustesView(); break;
            case 'diseno':       toggleDropdown(false); disenoView(); break;
            case 'set-theme': {
                if (!window.FHTheme) break;
                const id = btn.dataset.themeId;
                FHTheme.set(id);
                /* Se marca el elegido a mano en vez de repintar la vista: si
                   se repintara, el modal saltaría al principio y en Ajustes
                   perderías de vista dónde estabas. */
                modal.querySelectorAll('.pw-theme').forEach(b => {
                    const on = b.dataset.themeId === id;
                    b.classList.toggle('pw-theme--on', on);
                    b.setAttribute('aria-pressed', String(on));
                });
                break;
            }
            case 'change-username': changeUsernameView(); break;
            case 'change-photo': {
                const input = modal.querySelector('.pw-file');
                if (input) input.click();
                break;
            }
            case 'logout':
                toggleDropdown(false);
                closeModal();
                await FHAuth.signOut();
                break;
        }
    });

    modal.addEventListener('click', (e) => {
        if (e.target.closest('.pw-close') && !e.target.closest('[data-action]')) closeModal();
    });

    document.addEventListener('submit', (e) => {
        const form = e.target.closest('.pw-form');
        if (!form) return;
        e.preventDefault();
        handleSubmit(form);
    });

    /* Foto de perfil: al elegir un archivo, abrir el recortador circular;
       solo se sube tras confirmar el encuadre. */
    modal.addEventListener('change', async (e) => {
        const input = e.target.closest('.pw-file');
        if (!input || !input.files || !input.files[0]) return;
        const file = input.files[0];
        input.value = '';               // permite volver a elegir el mismo archivo
        setMsg('', '');

        if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
            return setMsg('error', 'La foto debe ser una imagen (JPG, PNG, WEBP o GIF).');
        }
        if (file.size > 20 * 1024 * 1024) {
            return setMsg('error', 'La imagen es demasiado grande (máximo 20 MB).');
        }

        let cropped;
        try {
            cropped = await openCropper(file);   // Blob cuadrado ya recortado, o null si cancela
        } catch (err) {
            return setMsg('error', 'No se pudo leer la imagen.');
        }
        if (!cropped) return;   // el usuario canceló

        setBusy(true);
        try {
            setMsg('', 'Subiendo foto…');
            const r = await FHAuth.uploadAvatar(cropped);
            if (!r.ok) return setMsg('error', r.error);
            profile = await FHAuth.getProfile(true);
            renderCircle();
            perfilView();                // repinta con la foto nueva
            setMsg('ok', 'Foto de perfil actualizada.');
        } finally {
            setBusy(false);
        }
    });

    /* ─────────────────── Estado de sesión → repintar ─────────────────── */

    async function refresh(event) {
        session = await FHAuth.getSession();
        profile = session ? await FHAuth.getProfile() : null;
        renderCircle();
        if (!dropdown.hidden) renderDropdown();

        if (event === 'PASSWORD_RECOVERY') {
            newPasswordView();
        } else if (session && profile && !profile.username) {
            // Primer login con Google: falta elegir nombre de usuario
            if (!modal.querySelector('[data-form="choose-username"]')) chooseUsernameView();
        }
        root.classList.add('pw-ready');
    }

    // setTimeout: no llamar a supabase-js dentro del propio callback de
    // onAuthStateChange (mantiene un lock interno y puede bloquearse)
    FHAuth.onChange((event) => { setTimeout(() => refresh(event), 0); });

    /* En los juegos hay columnas de anuncios fijas pegadas al borde derecho
       (.ad-col, position:fixed). Desplazamos el círculo a su izquierda para
       que no las tape. En el hub esas columnas son estáticas (parte del
       grid), así que no se detectan y el círculo se queda en su sitio. */
    function positionClearOfAds() {
        // .ad-col = la mayoría de juegos; .bj-ad-sidebar = blackjack (misma idea)
        // Usamos clientWidth (sin la barra de scroll): una columna fija a la
        // derecha llega hasta ese borde, aunque innerWidth sea mayor.
        const vw = document.documentElement.clientWidth || window.innerWidth;
        let shift = 0;
        document.querySelectorAll('.ad-col, .bj-ad-sidebar').forEach(c => {
            const cs = getComputedStyle(c);
            if (cs.position !== 'fixed' || cs.display === 'none') return;
            const r = c.getBoundingClientRect();
            if (r.width > 0 && r.right >= vw - 2) {
                shift = Math.max(shift, r.width);
            }
        });
        root.style.right = shift > 0 ? (shift + 12) + 'px' : '';
    }
    window.addEventListener('resize', positionClearOfAds);
    window.addEventListener('load', positionClearOfAds);

    /* ═══════════════════════════════════════════════════════════
       RECORTADOR CIRCULAR DE FOTO DE PERFIL
       Un recuadro con la foto y una máscara circular encima. Se
       arrastra y se hace zoom para encuadrar; al confirmar se
       dibuja el trozo visible en un canvas cuadrado y se devuelve
       como Blob JPEG listo para subir (mismo criterio que las RRSS:
       se guarda cuadrado y se muestra en círculo).
       ═══════════════════════════════════════════════════════════ */
    const CROP_OUT = 512;   // lado del JPEG resultante

    function openCropper(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => start(img, url, resolve, reject);
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagen inválida')); };
            img.src = url;
        });
    }

    function start(img, url, resolve, reject) {
        const back = document.createElement('div');
        back.className = 'pw-crop-back';
        back.innerHTML = `
          <div class="pw-crop-modal" role="dialog" aria-modal="true">
            <div class="pw-crop-title">Ajusta tu foto</div>
            <div class="pw-crop-stage">
              <canvas class="pw-crop-canvas"></canvas>
              <div class="pw-crop-ring"></div>
            </div>
            <div class="pw-crop-zoom">
              <span class="pw-crop-zi pw-crop-zi-sm">A</span>
              <input class="pw-crop-range" type="range" min="1" max="4" step="0.01" value="1"
                     aria-label="Zoom">
              <span class="pw-crop-zi pw-crop-zi-lg">A</span>
            </div>
            <div class="pw-crop-actions">
              <button class="pw-crop-btn pw-crop-cancel" type="button">Cancelar</button>
              <button class="pw-crop-btn pw-crop-ok" type="button">Guardar foto</button>
            </div>
          </div>`;
        document.body.appendChild(back);

        const canvas = back.querySelector('.pw-crop-canvas');
        const range  = back.querySelector('.pw-crop-range');
        const ctx    = canvas.getContext('2d');

        // Lienzo cuadrado del tamaño real del recuadro (con densidad de pantalla)
        const V   = Math.min(300, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.7));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.style.width = canvas.style.height = V + 'px';
        canvas.width = canvas.height = V * dpr;
        ctx.scale(dpr, dpr);

        const natW = img.naturalWidth, natH = img.naturalHeight;
        const coverScale = Math.max(V / natW, V / natH);   // escala mínima: la foto cubre el recuadro

        let zoom = 1;                 // 1 = cubrir; hasta 4x
        let tx = 0, ty = 0;           // esquina sup-izq de la imagen respecto al recuadro (px)

        function dispScale() { return coverScale * zoom; }

        // Mantener la imagen siempre cubriendo el recuadro (sin huecos)
        function clamp() {
            const dw = natW * dispScale(), dh = natH * dispScale();
            const minX = V - dw, minY = V - dh;
            if (tx > 0) tx = 0; if (tx < minX) tx = minX;
            if (ty > 0) ty = 0; if (ty < minY) ty = minY;
        }

        function draw() {
            clamp();
            ctx.clearRect(0, 0, V, V);
            const dw = natW * dispScale(), dh = natH * dispScale();
            ctx.drawImage(img, tx, ty, dw, dh);
        }

        // Centrar al abrir
        function center() {
            const dw = natW * dispScale(), dh = natH * dispScale();
            tx = (V - dw) / 2; ty = (V - dh) / 2;
            draw();
        }
        center();

        // ── Arrastrar ──
        let dragging = false, lastX = 0, lastY = 0;
        const stage = back.querySelector('.pw-crop-stage');
        stage.addEventListener('pointerdown', (ev) => {
            dragging = true; lastX = ev.clientX; lastY = ev.clientY;
            stage.setPointerCapture(ev.pointerId);
        });
        stage.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            tx += ev.clientX - lastX; ty += ev.clientY - lastY;
            lastX = ev.clientX; lastY = ev.clientY;
            draw();
        });
        const endDrag = () => { dragging = false; };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);

        // ── Zoom con la rueda, manteniendo el punto bajo el cursor ──
        stage.addEventListener('wheel', (ev) => {
            ev.preventDefault();
            const rect = canvas.getBoundingClientRect();
            applyZoom(zoom * (ev.deltaY < 0 ? 1.08 : 1 / 1.08),
                      ev.clientX - rect.left, ev.clientY - rect.top);
        }, { passive: false });

        // ── Zoom con el deslizador (respecto al centro) ──
        range.addEventListener('input', () => applyZoom(parseFloat(range.value), V / 2, V / 2));

        function applyZoom(nz, px, py) {
            nz = Math.max(1, Math.min(4, nz));
            // Punto de imagen bajo (px,py) antes de escalar
            const s0 = dispScale();
            const ix = (px - tx) / s0, iy = (py - ty) / s0;
            zoom = nz;
            const s1 = dispScale();
            tx = px - ix * s1; ty = py - iy * s1;
            range.value = zoom;
            draw();
        }

        // ── Cerrar / confirmar ──
        function cleanup() { URL.revokeObjectURL(url); back.remove(); }

        back.querySelector('.pw-crop-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
        back.addEventListener('click', (ev) => { if (ev.target === back) { cleanup(); resolve(null); } });

        back.querySelector('.pw-crop-ok').addEventListener('click', () => {
            clamp();
            const out = document.createElement('canvas');
            out.width = out.height = CROP_OUT;
            const octx = out.getContext('2d');
            // Trozo de la imagen original que ocupa el recuadro
            const s = dispScale();
            const srcX = -tx / s, srcY = -ty / s, srcWH = V / s;
            octx.drawImage(img, srcX, srcY, srcWH, srcWH, 0, 0, CROP_OUT, CROP_OUT);
            out.toBlob((blob) => {
                cleanup();
                if (!blob) return reject(new Error('no se pudo recortar'));
                // Nombre y tipo para que uploadAvatar calcule bien la extensión
                resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
            }, 'image/jpeg', 0.9);
        });
    }

    function mount() {
        document.body.appendChild(root);
        document.body.appendChild(overlay);
        positionClearOfAds();
        refresh('INITIAL');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
