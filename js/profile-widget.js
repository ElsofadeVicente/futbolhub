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

    function avatarHTML(size) {
        if (profile && profile.avatar_url) {
            return `<img class="pw-avatar-img" src="${esc(profile.avatar_url)}" alt="">`;
        }
        if (session) {
            const seed = (profile && profile.username) ||
                         (session.user && session.user.email) || '?';
            const av = FHAuth.defaultAvatar(seed);
            return `<span class="pw-avatar-letter" style="background:${av.color}">${esc(av.letter)}</span>`;
        }
        return USER_ICON;
    }

    function displayName() {
        if (profile && profile.username) return '@' + profile.username;
        if (session && session.user) return session.user.email || 'Tu cuenta';
        return '';
    }

    /* ─────────────────────── Círculo + desplegable ─────────────────────── */

    function renderCircle() {
        circleInner.innerHTML = avatarHTML();
        circleBtn.classList.toggle('pw-logged', !!session);
    }

    function renderDropdown() {
        if (!session) {
            dropdown.innerHTML = `
              <button class="pw-login-cta" type="button" data-action="open-login">Iniciar sesión</button>
              <div class="pw-drop-note">Guarda tus estadísticas en todos los juegos</div>`;
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

    function placeholderView(title) {
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">${esc(title)}</h3>
          <p class="pw-text">Próximamente: aquí verás tu ${title.toLowerCase()} de todos los juegos.</p>
        `);
    }

    function ajustesView() {
        const changed = !!(profile && profile.username_changed);
        openModal(`
          <div class="pw-brand">Fútbol<span>HUB</span></div>
          <h3 class="pw-title">Ajustes</h3>

          <div class="pw-settings-row">
            <span class="pw-drop-avatar pw-avatar-lg">${avatarHTML()}</span>
            <div class="pw-drop-id">
              <div class="pw-drop-name">${esc(displayName())}</div>
              <div class="pw-drop-mail">${esc(session && session.user.email || '')}</div>
            </div>
          </div>

          <button class="pw-secondary" type="button" data-action="change-photo">Cambiar foto de perfil</button>
          <input class="pw-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>

          <div class="pw-field-label">Nombre de usuario</div>
          ${changed
            ? `<p class="pw-hint">Ya has usado tu único cambio de nombre, así que no se puede volver a cambiar.</p>`
            : `<button class="pw-secondary" type="button" data-action="change-username">Cambiar nombre de usuario</button>
               <p class="pw-hint">Solo se puede cambiar <strong>una vez</strong>. Elige bien.</p>`}

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
          <button class="pw-linkbtn" type="button" data-action="ajustes">← Cancelar</button>
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
                setTimeout(ajustesView, 1200);
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
            case 'perfil':       toggleDropdown(false); placeholderView('Perfil'); break;
            case 'estadisticas': toggleDropdown(false); placeholderView('Estadísticas'); break;
            case 'ajustes':      toggleDropdown(false); ajustesView(); break;
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

    /* Foto de perfil: al elegir un archivo, subirlo y repintar el avatar */
    modal.addEventListener('change', async (e) => {
        const input = e.target.closest('.pw-file');
        if (!input || !input.files || !input.files[0]) return;
        const file = input.files[0];
        input.value = '';               // permite volver a elegir el mismo archivo
        setMsg('', '');
        setBusy(true);
        try {
            setMsg('', 'Subiendo foto…');
            const r = await FHAuth.uploadAvatar(file);
            if (!r.ok) return setMsg('error', r.error);
            profile = await FHAuth.getProfile(true);
            renderCircle();
            ajustesView();              // repinta con la foto nueva
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
        let shift = 0;
        document.querySelectorAll('.ad-col').forEach(c => {
            const cs = getComputedStyle(c);
            if (cs.position !== 'fixed' || cs.display === 'none') return;
            const r = c.getBoundingClientRect();
            if (r.width > 0 && Math.abs(r.right - window.innerWidth) <= 2) {
                shift = Math.max(shift, r.width);
            }
        });
        root.style.right = shift > 0 ? (shift + 12) + 'px' : '';
    }
    window.addEventListener('resize', positionClearOfAds);
    window.addEventListener('load', positionClearOfAds);

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
