/* ============================================================
   FutbolHUB Design Editor — editor.js  (v2)
   Mover (preservando transforms), tipografia, tokens, persistencia
   ============================================================ */

const API = "/__fhe_api__";
const $ = (sel) => document.querySelector(sel);

const state = {
  mode: "play",          // "play" | "edit"
  paused: false,
  selected: null,        // elemento seleccionado dentro del iframe
  matchingRules: [],     // reglas CSS que matchean el elemento
  targetRuleIndex: -1,   // regla por defecto (fallback) para props nuevas
  pending: {},           // { propiedad: valor } cambios sin guardar
  lastBackups: [],       // [{path, backup}] para deshacer
  tokens: [],            // design tokens detectados
  tokenTargets: {},      // destino (archivo/regla) por cada token editado
  lastSave: {},          // diagnostico del ultimo guardado
  dragging: false,
  move: { mode: "transform", x: 0, y: 0, rest: "", pos: "static" },
  dragBase: { x: 0, y: 0, rest: "" },
  dragStart: { x: 0, y: 0 },
};

const frame = $("#stage");
const fdoc = () => frame.contentDocument;
const fwin = () => frame.contentWindow;

/* ----------------------------------------------------------------
   Navegacion
----------------------------------------------------------------- */
function go(path) {
  if (!path.startsWith("/")) path = "/" + path;
  frame.src = path;
}
$("#btn-home").addEventListener("click", () => go($("#start-path").value || "/index.html"));
$("#start-path").addEventListener("keydown", (e) => { if (e.key === "Enter") go($("#start-path").value || "/index.html"); });
$("#btn-back").addEventListener("click", () => { try { fwin().history.back(); } catch (e) {} });

frame.addEventListener("load", onFrameLoaded);

function onFrameLoaded() {
  try { $("#current-url").textContent = new URL(fwin().location.href).pathname; }
  catch (e) { $("#current-url").textContent = "(cargando...)"; }
  injectEditorStyles();
  if (state.paused) applyPause();
  attachHandlers();
  setMode(state.mode);
  scanTokens();
}

/* ----------------------------------------------------------------
   Estilos inyectados dentro del iframe
----------------------------------------------------------------- */
function injectEditorStyles() {
  const doc = fdoc();
  if (!doc || doc.getElementById("__fhe_style__")) return;
  const s = doc.createElement("style");
  s.id = "__fhe_style__";
  s.textContent = `
    .__fhe_hover__ { outline: 2px dashed #b5221e !important; outline-offset: -2px !important; }
    .__fhe_selected__ { outline: 3px solid #b5221e !important; outline-offset: -3px !important; }
    body[data-fhe-edit] * { cursor: crosshair !important; }
    body[data-fhe-edit] .__fhe_selected__ { cursor: move !important; }
  `;
  doc.head && doc.head.appendChild(s);
}

/* ----------------------------------------------------------------
   Modos
----------------------------------------------------------------- */
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $("#btn-edit").classList.toggle("active", mode === "edit");
  $("#btn-play").classList.toggle("active", mode === "play");
  const doc = fdoc();
  if (!doc) return;
  if (mode === "edit") {
    doc.body && doc.body.setAttribute("data-fhe-edit", "1");
  } else {
    doc.body && doc.body.removeAttribute("data-fhe-edit");
    clearSelection();
    $("#panel").classList.add("hidden");
  }
}
$("#btn-play").addEventListener("click", () => setMode("play"));
$("#btn-edit").addEventListener("click", () => setMode("edit"));

/* ----------------------------------------------------------------
   Dispositivos: ancho FIJO del lienzo (no se reajusta al abrir panel)
----------------------------------------------------------------- */
const DEVICE_W = { mobile: 390, tablet: 768, desktop: 1280, full: null };
function setDevice(mode) {
  const w = DEVICE_W[mode];
  frame.style.width = (w === null) ? "100%" : w + "px";
  ["mobile", "tablet", "desktop", "full"].forEach((d) =>
    $("#dev-" + d).classList.toggle("active", d === mode));
  // re-analizar la seleccion: al cambiar el ancho, cambian las @media que aplican
  if (state.selected && state.mode === "edit") {
    state.matchingRules = analyzeRules(state.selected);
    state.targetRuleIndex = state.matchingRules.length ? pickDefaultRuleIndex() : -1;
    buildPanel();
  }
}
$("#dev-mobile").addEventListener("click", () => setDevice("mobile"));
$("#dev-tablet").addEventListener("click", () => setDevice("tablet"));
$("#dev-desktop").addEventListener("click", () => setDevice("desktop"));
$("#dev-full").addEventListener("click", () => setDevice("full"));

/* ----------------------------------------------------------------
   Handlers de seleccion + arrastre dentro del iframe
----------------------------------------------------------------- */
function attachHandlers() {
  const doc = fdoc();
  if (!doc || doc.__fheHandlers) return;
  doc.__fheHandlers = true;

  doc.addEventListener("mouseover", (e) => {
    if (state.mode !== "edit" || state.dragging) return;
    e.target.classList && e.target.classList.add("__fhe_hover__");
  }, true);
  doc.addEventListener("mouseout", (e) => {
    e.target.classList && e.target.classList.remove("__fhe_hover__");
  }, true);

  // mousedown: si pulsas sobre el elemento ya seleccionado -> empieza arrastre
  doc.addEventListener("mousedown", (e) => {
    if (state.mode !== "edit") return;
    if (state.selected && (e.target === state.selected || state.selected.contains(e.target))) {
      startDrag(e);
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  doc.addEventListener("mousemove", (e) => { if (state.dragging) onDrag(e); }, true);
  doc.addEventListener("mouseup", (e) => { if (state.dragging) endDrag(e); }, true);

  // click: seleccionar (si no venimos de un arrastre)
  doc.addEventListener("click", (e) => {
    if (state.mode !== "edit") return;
    e.preventDefault();
    e.stopPropagation();
    if (state.justDragged) { state.justDragged = false; return; }
    selectElement(e.target);
  }, true);

  // bloquear logica del juego en modo edicion
  ["submit", "keydown", "keypress", "dblclick"].forEach((ev) => {
    doc.addEventListener(ev, (e) => { if (state.mode === "edit") e.stopPropagation(); }, true);
  });
}

/* ----------------------------------------------------------------
   Arrastre = mover preservando el transform existente
----------------------------------------------------------------- */
function startDrag(e) {
  state.dragging = true;
  state.dragStart = { x: e.clientX, y: e.clientY };
  state.dragBase = { x: state.move.x, y: state.move.y };
}
function onDrag(e) {
  const dx = e.clientX - state.dragStart.x;
  const dy = e.clientY - state.dragStart.y;
  state.move.x = Math.round(state.dragBase.x + dx);
  state.move.y = Math.round(state.dragBase.y + dy);
  applyMovePreview();
  state.justDragged = true;
  const xin = $("#move-x"), yin = $("#move-y");
  if (xin) xin.value = state.move.x;
  if (yin) yin.value = state.move.y;
}
function endDrag(e) {
  state.dragging = false;
}

/* ----------------------------------------------------------------
   Sistema de movimiento consciente del layout
   - elemento en flujo (position:static) -> margin (reordena, no solapa)
   - elemento posicionado (absolute/fixed/relative) -> transform (no reflow)
----------------------------------------------------------------- */
function parsePx(v) { const m = /(-?[\d.]+)px/.exec(v || ""); return m ? parseFloat(m[1]) : 0; }

function initMove() {
  const el = state.selected;
  const pos = el ? fwin().getComputedStyle(el).position : "static";
  // SIEMPRE transform: mueve solo este elemento, sin afectar al flujo ni a los vecinos
  const idx = targetIndexForProp("transform");
  const rule = (idx >= 0 && state.matchingRules[idx]) ? state.matchingRules[idx].rule : null;
  const d = parseTransform(rule ? (rule.style.transform || "") : "");
  state.move = { mode: "transform", x: d.x, y: d.y, rest: d.rest, pos };
}

function applyMovePreview() {
  const m = state.move; if (!state.selected) return;
  preview("transform", composeTransform(m.rest, m.x, m.y));
}

function parseTransform(str) {
  let x = 0, y = 0, rest = "";
  if (str && str !== "none") {
    const tm = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(str);
    const tmx = /translate\(\s*(-?[\d.]+)px\s*\)/.exec(str);
    const mm = /matrix\(\s*([^)]+)\)/.exec(str);
    if (tm) {
      x = parseFloat(tm[1]); y = parseFloat(tm[2]);
      rest = str.replace(/translate\([^)]*\)/, "").replace(/\s+/g, " ").trim();
    } else if (tmx) {
      x = parseFloat(tmx[1]);
      rest = str.replace(/translate\([^)]*\)/, "").replace(/\s+/g, " ").trim();
    } else if (mm) {
      const p = mm[1].split(",").map((s) => parseFloat(s.trim()));
      // matrix(a,b,c,d,e,f): si es traslacion pura (a=1,b=0,c=0,d=1) -> e,f
      if (p.length === 6 && p[0] === 1 && p[1] === 0 && p[2] === 0 && p[3] === 1) {
        x = p[4]; y = p[5]; rest = "";
      } else {
        // matriz compleja (rotacion/escala): no la tocamos, partimos de 0
        x = 0; y = 0; rest = "";
      }
    }
  }
  return { x, y, rest };
}
function composeTransform(rest, x, y) {
  const t = `translate(${x}px, ${y}px)`;
  return rest ? `${rest} ${t}` : t;
}

/* ----------------------------------------------------------------
   Seleccion + analisis de reglas
----------------------------------------------------------------- */
function clearSelection() {
  if (state.selected && state.selected.classList) state.selected.classList.remove("__fhe_selected__");
  state.selected = null;
  state.pending = {};
}
function selectElement(el) {
  clearSelection();
  state.selected = el;
  el.classList.add("__fhe_selected__");
  state.matchingRules = analyzeRules(el);
  state.targetRuleIndex = state.matchingRules.length ? pickDefaultRuleIndex() : -1;
  state.pending = {};
  buildPanel();
  showPanel("element");
}

function specificity(sel) {
  const a = (sel.match(/#[\w-]+/g) || []).length;
  const b = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const c = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return a * 100 + b * 10 + c;
}
function matchingPart(el, selectorText) {
  for (const p of selectorText.split(",").map((s) => s.trim())) {
    try { if (el.matches(p)) return p; } catch (e) {}
  }
  return selectorText;
}
function hrefToPath(href) {
  if (!href) return null;
  try {
    const u = new URL(href);
    if (u.origin !== location.origin) return null;
    return u.pathname.replace(/^\//, "");
  } catch (e) { return null; }
}
function analyzeRules(el) {
  const doc = fdoc(), win = fwin(), out = [];
  Array.from(doc.styleSheets).forEach((sheet) => {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { return; }
    if (!rules) return;
    const file = hrefToPath(sheet.href);
    if (!file) return;
    (function walk(list, mediaText) {
      Array.from(list).forEach((rule) => {
        if (rule.type === CSSRule.MEDIA_RULE) walk(rule.cssRules, "@media " + rule.media.mediaText);
        else if (rule.type === CSSRule.STYLE_RULE) {
          let m = false;
          try { m = el.matches(rule.selectorText); } catch (e) {}
          if (!m) return;
          let affected = 0;
          try { affected = doc.querySelectorAll(rule.selectorText).length; } catch (e) {}
          // ¿esta regla APLICA ahora mismo? (sin media = siempre; con media = matchMedia)
          let applies = true;
          if (mediaText) {
            const cond = mediaText.replace(/^@media\s*/i, "");
            try { applies = win.matchMedia(cond).matches; } catch (e) { applies = false; }
          }
          out.push({ file, selector: rule.selectorText, media: mediaText, applies,
                     spec: specificity(matchingPart(el, rule.selectorText)), affected, rule });
        }
      });
    })(rules, null);
  });
  out.sort((x, y) => x.spec - y.spec);
  return out;
}

/* indice de la MEJOR regla por defecto: que APLIQUE ahora, mas especifica, ultima */
function pickDefaultRuleIndex() {
  let best = -1, bestScore = -1;
  state.matchingRules.forEach((r, i) => {
    // puntua: aplicar pesa mucho mas que la especificidad
    const score = (r.applies ? 100000 : 0) + r.spec * 10 + i;
    if (score >= bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/* target para una propiedad: regla que YA la define y APLICA (mas especifica);
   si ninguna que aplique la define, la mejor regla que aplica; si no, el fallback */
function targetIndexForProp(prop) {
  let best = -1, bestScore = -1;
  state.matchingRules.forEach((r, i) => {
    const sets = !!(r.rule.style.getPropertyValue(prop) || "").trim();
    if (!r.applies) return;                 // solo reglas que aplican al viewport
    const score = (sets ? 100000 : 0) + r.spec * 10 + i;
    if (score >= bestScore) { bestScore = score; best = i; }
  });
  if (best >= 0) return best;
  return state.targetRuleIndex;             // fallback (no deberia pasar)
}

/* ----------------------------------------------------------------
   Panel de propiedades del elemento
----------------------------------------------------------------- */
function cssVal(prop) {
  if (!state.selected) return "";
  return fwin().getComputedStyle(state.selected).getPropertyValue(prop).trim();
}

function buildPanel() {
  const el = state.selected;
  const tag = el.tagName.toLowerCase();
  const cls = (typeof el.className === "string")
    ? el.className.split(/\s+/).filter((c) => c && !c.startsWith("__fhe")).map((c) => "." + c).join("")
    : "";
  $("#sel-tag").textContent = `<${tag}>${el.id ? "#" + el.id : ""}${cls}`;

  // dropdown de reglas (fallback para propiedades nuevas)
  const rs = $("#rule-select");
  rs.innerHTML = "";
  if (!state.matchingRules.length) {
    const o = document.createElement("option");
    o.textContent = "(sin regla — se creará una nueva)"; o.value = "-1"; rs.appendChild(o);
  } else {
    state.matchingRules.forEach((r, i) => {
      const o = document.createElement("option");
      const flag = r.applies ? "" : "  ⚠ no aplica ahora";
      o.textContent = `${r.selector}${r.media ? " " + r.media : ""} — ${r.file} (×${r.affected})${flag}`;
      o.value = String(i); rs.appendChild(o);
    });
    rs.value = String(state.targetRuleIndex);
  }
  rs.onchange = () => { state.targetRuleIndex = parseInt(rs.value, 10); updateAffected(); };
  updateAffected();

  const C = $("#controls");
  C.innerHTML = "";

  group(C, "Mover");
  addMove(C);

  group(C, "Tipografía");
  addColor(C, "Color de texto", "color");
  addText(C, "Familia (fuente)", "font-family", "'Anton', sans-serif");
  addText(C, "Tamaño", "font-size", "ej. 1.2rem / 18px");
  addText(C, "Grosor", "font-weight", "400 / 700 / bold");
  addText(C, "Interletra", "letter-spacing", "ej. 0.1em");
  addText(C, "Interlínea", "line-height", "ej. 1.2");
  addText(C, "Transformar", "text-transform", "uppercase / none");
  addText(C, "Alineación", "text-align", "left / center / right");

  group(C, "Caja y color");
  addColor(C, "Fondo", "background-color");
  addColor(C, "Color de borde", "border-color");
  addText(C, "Grosor de borde", "border-width", "ej. 2px");
  addText(C, "Radio de borde", "border-radius", "ej. 8px");
  addText(C, "Sombra", "box-shadow", "ej. 4px 4px 0 #000");
  addText(C, "Padding", "padding", "ej. 12px 16px");
  addText(C, "Margin", "margin", "ej. 0 auto");
  addText(C, "Ancho", "width", "⚠ ojo con layout responsive");
  addText(C, "Alto", "height", "ej. 120px / auto");

  group(C, "Otra propiedad CSS");
  addCustom(C);
}

function updateAffected() {
  const r = state.matchingRules[state.targetRuleIndex];
  const note = $("#affected-note");
  if (!r) { note.textContent = "Se creará una regla nueva."; return; }
  let live = 0;
  try { live = fdoc().querySelectorAll(r.selector).length; } catch (e) {}
  if (!r.applies) {
    note.innerHTML = `⚠ Esta regla está dentro de <b>${r.media}</b> y NO aplica a tu pantalla ahora. ` +
      `Lo que guardes aquí no se verá. Elige una regla sin "no aplica".`;
  } else {
    note.textContent = `"${r.selector}" la usan ${live} elemento(s) ahora mismo. Las propiedades se guardan en la regla que aplica.`;
  }
}

function group(parent, title) {
  const h = document.createElement("div");
  h.className = "grp"; h.textContent = title;
  parent.appendChild(h);
}
function addRow(parent, label) {
  const row = document.createElement("div");
  row.className = "row";
  if (label) { const l = document.createElement("label"); l.textContent = label; row.appendChild(l); }
  parent.appendChild(row);
  return row;
}
function rgbToHex(c) {
  if (!c) return null;
  if (c.startsWith("#")) return c.length === 7 ? c : null;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return null;
  const h = (n) => parseInt(n).toString(16).padStart(2, "0");
  return "#" + h(m[1]) + h(m[2]) + h(m[3]);
}
function addColor(parent, label, prop) {
  const row = addRow(parent, label);
  const cur = cssVal(prop), hex = rgbToHex(cur);
  const color = document.createElement("input"); color.type = "color"; if (hex) color.value = hex;
  const txt = document.createElement("input"); txt.type = "text"; txt.className = "txt"; txt.value = cur;
  color.oninput = () => { txt.value = color.value; preview(prop, color.value); };
  txt.oninput = () => { preview(prop, txt.value); const h = rgbToHex(txt.value); if (h) color.value = h; };
  row.appendChild(color); row.appendChild(txt);
}
function addText(parent, label, prop, ph) {
  const row = addRow(parent, label);
  const txt = document.createElement("input"); txt.type = "text"; txt.className = "txt wide";
  txt.placeholder = ph || ""; txt.value = cssVal(prop);
  txt.oninput = () => preview(prop, txt.value);
  row.appendChild(txt);
}
function addMove(parent) {
  initMove();
  const m = state.move;
  const row = addRow(parent, "Arrastra el elemento o usa X / Y");
  const pad = document.createElement("div"); pad.className = "move-pad";
  const xin = document.createElement("input"); xin.id = "move-x"; xin.type = "number"; xin.value = m.x; xin.className = "txt num";
  const yin = document.createElement("input"); yin.id = "move-y"; yin.type = "number"; yin.value = m.y; yin.className = "txt num";
  const sync = () => { xin.value = m.x; yin.value = m.y; applyMovePreview(); };
  const mk = (t, dx, dy) => { const b = document.createElement("button"); b.textContent = t;
    b.onclick = () => { m.x += dx; m.y += dy; sync(); }; return b; };
  xin.oninput = () => { m.x = parseInt(xin.value || 0); applyMovePreview(); };
  yin.oninput = () => { m.y = parseInt(yin.value || 0); applyMovePreview(); };
  pad.append(mk("←", -5, 0), mk("→", 5, 0), mk("↑", 0, -5), mk("↓", 0, 5));
  const xy = document.createElement("div"); xy.className = "xy"; xy.append("X", xin, "Y", yin);
  row.append(pad, xy);

  // nota del modo de movimiento
  const note = document.createElement("div"); note.className = "note small";
  note.textContent = "Mueve SOLO este elemento (transform). No afecta a los demás." +
    (m.rest ? " Conserva: " + m.rest : "");
  row.appendChild(note);

  // boton de reset (pone X/Y a 0)
  const reset = document.createElement("button"); reset.textContent = "⟲ X/Y a 0";
  reset.className = "mini"; reset.style.marginTop = "6px";
  reset.onclick = () => { m.x = 0; m.y = 0; sync(); };
  row.appendChild(reset);
}
function addCustom(parent) {
  const row = addRow(parent, "");
  const name = document.createElement("input"); name.type = "text"; name.className = "txt"; name.placeholder = "propiedad";
  const val = document.createElement("input"); val.type = "text"; val.className = "txt"; val.placeholder = "valor";
  const btn = document.createElement("button"); btn.textContent = "+";
  btn.onclick = () => { if (name.value.trim()) { preview(name.value.trim(), val.value); toast(`${name.value.trim()} en cola`); } };
  row.append(name, val, btn);
}

function preview(prop, value) {
  if (!state.selected) return;
  state.selected.style.setProperty(prop, value);
  state.pending[prop] = value;
}

/* ----------------------------------------------------------------
   Guardado: cada propiedad va a la regla que ya la define (o al fallback)
----------------------------------------------------------------- */
$("#btn-save").addEventListener("click", () => saveAll(false));

async function saveAll(isToken) {
  const props = Object.keys(state.pending);
  if (!props.length) { toast("No hay cambios."); return; }
  $("#btn-save").disabled = true;
  state.lastBackups = [];
  state.lastSave = {};
  const errors = []; let ok = 0; const filesTouched = new Set();

  for (const prop of props) {
    let target;
    if (isToken) target = state.tokenTargets[prop];     // destino propio de cada token
    else {
      const idx = targetIndexForProp(prop);
      target = state.matchingRules[idx >= 0 ? idx : state.targetRuleIndex];
    }
    if (!target) { errors.push(`${prop}: sin regla destino`); continue; }
    try {
      const res = await fetch(`${API}/css-edit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target.file, selector: target.selector,
          media: target.media || null, property: prop, value: state.pending[prop], create: true }),
      });
      const data = await res.json();
      if (data.ok) {
        ok++; filesTouched.add(target.file);
        state.lastSave.abspath = data.abspath;
        state.lastSave.verified = data.verified;
        if (data.backup) state.lastBackups.push({ path: target.file, backup: data.backup });
      } else errors.push(`${prop}: ${data.error}`);
    } catch (e) { errors.push(`${prop}: ${e.message}`); }
  }
  // capturar el contenido recien escrito para el re-chequeo de reversion
  const firstFile = [...filesTouched][0];
  if (firstFile) {
    try {
      const r = await fetch(`${API}/read?path=${encodeURIComponent(firstFile)}`);
      const d = await r.json();
      if (d.ok) state.lastSave.content = d.content;
    } catch (e) {}
  }
  $("#btn-save").disabled = false;
  filesTouched.forEach((f) => refreshStylesheet(f));
  if (!isToken) props.forEach((p) => state.selected && state.selected.style.removeProperty(p));
  state.pending = {};
  $("#btn-undo").disabled = !state.lastBackups.length;
  if (errors.length) { toast(`Parcial. Errores: ${errors.join("; ")}`, true); return; }

  // diagnostico: ruta absoluta + verificacion inmediata
  const abs = state.lastSave.abspath || "?";
  const verifiedNow = state.lastSave.verified;
  if (verifiedNow === false) {
    toast(`⚠ Guardado pero NO verificado en disco: ${abs}. El archivo no recibió el cambio.`, true);
    return;
  }
  toast(`✓ Escrito y verificado en: ${abs}`);
  console.log("[FHE] guardado en", abs);

  // re-chequeo tras 4s: ¿algo revierte el archivo? (Drive, sync, otro editor abierto)
  const checkFile = [...filesTouched][0];
  if (checkFile && state.lastSave.content) {
    const expected = state.lastSave.content;
    setTimeout(async () => {
      try {
        const r = await fetch(`${API}/read?path=${encodeURIComponent(checkFile)}`);
        const d = await r.json();
        if (d.ok && d.content !== expected) {
          toast(`⚠ ¡El archivo ${checkFile} se REVIRTIÓ tras 4s! Algo externo lo está cambiando (Drive/sync/otro programa).`, true);
          console.warn("[FHE] el archivo se revirtió tras guardar");
        } else if (d.ok) {
          console.log("[FHE] verificado: el archivo sigue con tu cambio tras 4s");
        }
      } catch (e) {}
    }, 4000);
  }
}

function refreshStylesheet(file) {
  const doc = fdoc(); if (!doc) return;
  Array.from(doc.querySelectorAll("link[rel=stylesheet]")).forEach((l) => {
    if (hrefToPath(l.href) === file) l.href = l.href.split("?")[0] + "?fhe=" + Date.now();
  });
}

$("#btn-undo").addEventListener("click", async () => {
  if (!state.lastBackups.length) return;
  for (const b of state.lastBackups) {
    await fetch(`${API}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    refreshStylesheet(b.path);
  }
  toast("↩ Deshecho."); state.lastBackups = []; $("#btn-undo").disabled = true;
});

/* ----------------------------------------------------------------
   Panel de Design Tokens
----------------------------------------------------------------- */
$("#btn-tokens").addEventListener("click", () => {
  // limpiar cualquier preview/pendiente de edicion de elemento
  if (state.selected) Object.keys(state.pending).forEach((p) => state.selected.style.removeProperty(p));
  state.pending = {};
  state.tokenTargets = {};
  scanTokens();
  buildTokenPanel();
  showPanel("tokens");
});

function scanTokens() {
  const doc = fdoc(); if (!doc) return;
  const map = new Map(); // name -> {value, file, selector, media}
  Array.from(doc.styleSheets).forEach((sheet) => {
    let rules; try { rules = sheet.cssRules; } catch (e) { return; }
    if (!rules) return;
    const file = hrefToPath(sheet.href); if (!file) return;
    (function walk(list, mediaText) {
      Array.from(list).forEach((rule) => {
        if (rule.type === CSSRule.MEDIA_RULE) walk(rule.cssRules, "@media " + rule.media.mediaText);
        else if (rule.type === CSSRule.STYLE_RULE) {
          for (let i = 0; i < rule.style.length; i++) {
            const p = rule.style[i];
            if (p.startsWith("--")) map.set(p, { value: rule.style.getPropertyValue(p).trim(), file, selector: rule.selectorText, media: mediaText });
          }
        }
      });
    })(rules, null);
  });
  state.tokens = Array.from(map.entries()).map(([name, info]) => ({ name, ...info }));
}

function buildTokenPanel() {
  const C = $("#token-list");
  C.innerHTML = "";
  if (!state.tokens.length) { C.innerHTML = "<p class='note'>No se detectaron variables CSS.</p>"; return; }
  state.tokens.forEach((tk) => {
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("label"); lab.textContent = tk.name; lab.title = `${tk.selector} — ${tk.file}`;
    row.appendChild(lab);
    const hex = rgbToHex(tk.value);
    if (hex || /^#|rgb/.test(tk.value)) {
      const color = document.createElement("input"); color.type = "color"; if (hex) color.value = hex;
      color.oninput = () => { txt.value = color.value; previewToken(tk, color.value); };
      row.appendChild(color);
    }
    const txt = document.createElement("input"); txt.type = "text"; txt.className = "txt"; txt.value = tk.value;
    txt.oninput = () => previewToken(tk, txt.value);
    row.appendChild(txt);
    C.appendChild(row);
  });
}
function previewToken(tk, value) {
  fdoc().documentElement.style.setProperty(tk.name, value);
  state.pending[tk.name] = value;
  // destino POR TOKEN (cada variable puede estar en un archivo/regla distinto)
  state.tokenTargets[tk.name] = { file: tk.file, selector: tk.selector, media: tk.media };
}
$("#btn-save-tokens").addEventListener("click", () => saveAll(true));

/* ----------------------------------------------------------------
   Mostrar/ocultar paneles
----------------------------------------------------------------- */
function showPanel(which) {
  $("#panel").classList.toggle("hidden", which !== "element");
  $("#token-panel").classList.toggle("hidden", which !== "tokens");
}
$("#btn-close-tokens").addEventListener("click", () => { showPanel("element"); state.pending = {}; });

/* ----------------------------------------------------------------
   Pausa profunda
----------------------------------------------------------------- */
$("#btn-pause").addEventListener("click", () => state.paused ? resume() : pause());
function pause() { state.paused = true; applyPause(); $("#btn-pause").textContent = "▶ Reanudar"; $("#btn-pause").classList.add("active"); toast("Pausa: animaciones y timers detenidos."); }
function applyPause() {
  const doc = fdoc(), win = fwin(); if (!doc) return;
  if (!doc.getElementById("__fhe_pause__")) {
    const s = doc.createElement("style"); s.id = "__fhe_pause__";
    s.textContent = `*,*::before,*::after{animation-play-state:paused!important;transition:none!important;}`;
    doc.head && doc.head.appendChild(s);
  }
  try { const maxId = win.setTimeout(() => {}, 0); for (let i = 0; i <= maxId; i++) { win.clearTimeout(i); win.clearInterval(i); } } catch (e) {}
}
function resume() {
  state.paused = false;
  const s = fdoc() && fdoc().getElementById("__fhe_pause__"); if (s) s.remove();
  $("#btn-pause").textContent = "⏸ Pausar"; $("#btn-pause").classList.remove("active");
  toast("Reanudado. (Recarga para juego fresco.)");
}

/* ----------------------------------------------------------------
   Toast + arranque
----------------------------------------------------------------- */
let toastTimer;
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = err ? "show error" : "show";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, 4200);
}
$("#btn-undo").disabled = true;
go($("#start-path").value || "/index.html");
