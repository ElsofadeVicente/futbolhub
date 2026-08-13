/* =============================================
   THEME.JS — Selector de diseño de la web
   FutbolHUB

   La web puede verse con dos diseños distintos SIN perder ninguno:

     classic → el de siempre (portada tipo periódico, papel y tinta)
     v2      → "Estadio": oscuro, esquinas redondeadas, verde césped

   Cómo funciona: este archivo escribe data-theme="<id>" en el <html>.
   El CSS de cada tema vive en su propia hoja y solo se activa cuando ese
   atributo coincide (css/hub-v2.css está TODO bajo [data-theme="v2"]), así
   que el diseño clásico no se toca ni una línea: si algún día el nuevo no
   convence, se borra su hoja y no queda rastro.

   Va en el <head> y SIN defer a propósito: tiene que poner el atributo
   antes de que el navegador pinte, o se vería un fogonazo del tema viejo.

   La elección se guarda en localStorage (por navegador, no por cuenta):
   es una preferencia visual, no progreso de juego.

   API: window.FHTheme.get() / .set(id) / .THEMES
        evento 'fh-theme' en window al cambiar.
   ============================================= */
(function () {
  'use strict';

  var KEY = 'fh_theme';

  var THEMES = [
    { id: 'classic', name: 'Clásico',  tag: 'Periódico' },
    { id: 'v2',      name: 'Moderno',  tag: 'Estadio'   }
  ];

  function isValid(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
    return false;
  }

  /* localStorage puede petar (modo privado de Safari, cookies bloqueadas):
     que un tema no pueda leerse nunca debe tumbar la página. */
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return isValid(v) ? v : 'classic';
    } catch (e) {
      return 'classic';
    }
  }

  function apply(id) {
    var html = document.documentElement;
    html.setAttribute('data-theme', id);
    /* color-scheme: que las barras de scroll y los controles nativos
       (selects, inputs de fecha) salgan oscuros en el tema oscuro. */
    html.style.colorScheme = (id === 'v2') ? 'dark' : '';
  }

  var current = read();
  apply(current);

  window.FHTheme = {
    THEMES: THEMES,
    get: function () { return current; },
    set: function (id) {
      if (!isValid(id) || id === current) return current;
      current = id;
      try { localStorage.setItem(KEY, id); } catch (e) {}
      apply(id);
      try {
        window.dispatchEvent(new CustomEvent('fh-theme', { detail: { theme: id } }));
      } catch (e) {}
      return current;
    }
  };
})();
