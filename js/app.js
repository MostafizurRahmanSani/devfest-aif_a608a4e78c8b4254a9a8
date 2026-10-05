// UI: state, rendering and event wiring.
const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const app = {
  data: null,      // validated building
  start: null,
  mode: "start",   // "start" | "hazard"
  blockedNodes: new Set(),
  blockedEdges: new Set(),
  closedExits: new Set(),
  flash: null,     // id of element just changed (for a short animation)
  lastRouteKey: "",
  routes: [],      // routes to every reachable exit, best first
  preview: null,   // exit ID of an alternative route shown dashed on the map
  pos: null,       // node id -> drawn {x, y}, used by the walkthrough
};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- loading ----------
function loadBuilding(raw) {
  const v = validateBuilding(raw);
  if (!v.ok) return showErrors(v.errors);
  app.data = v.data;
  app.start = null;
  app.lastRouteKey = "";
  resetHazards(false);
  hideBanner();
  render();
}

function resetHazards(doRender = true) {
  const i = app.data.initial;
  app.blockedNodes = new Set(i.blockedNodes);
  app.blockedEdges = new Set(i.blockedEdges);
  app.closedExits = new Set(i.closedExits);
  app.flash = null;
  if (doRender) render();
}

let lastErrors = null;
function showErrors(errors) {
  lastErrors = errors;
  const b = $("banner");
  b.hidden = false;
  b.innerHTML = "";
  const h = document.createElement("strong");
  h.textContent = t("importError");
  const ul = document.createElement("ul");
  errors.slice(0, 8).forEach((e) => {
    const li = document.createElement("li");
    li.textContent = t(e.key, e.p);
    ul.appendChild(li);
  });
  const close = document.createElement("button");
  close.className = "banner-close";
  close.type = "button";
  close.setAttribute("aria-label", t("close"));
  close.textContent = "×";
  close.onclick = hideBanner;
  b.append(h, ul, close);
}
function hideBanner() { lastErrors = null; $("banner").hidden = true; }

// ---------- interactions ----------
function onNode(id) {
  const n = app.data.nodes.find((x) => x.id === id);
  if (app.mode === "start") {
    if (n.type === "exit") return; // exits cannot be a start
    app.start = id;
  } else if (n.type === "exit") {
    toggle(app.closedExits, id);
  } else {
    toggle(app.blockedNodes, id);
  }
  app.flash = id;
  render();
}
function onEdge(id) {
  if (app.mode !== "hazard") return;
  toggle(app.blockedEdges, id);
  app.flash = id;
  render();
}
function toggle(set, id) { set.has(id) ? set.delete(id) : set.add(id); }

function activate(el, fn) {
  el.addEventListener("click", fn);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  });
}

// ---------- rendering ----------
function render() {
  stopWalk();
  applyStaticText();
  const has = !!app.data;
  $("emptyState").hidden = has;
  $("map").toggleAttribute("hidden", !has); // SVG has no .hidden property
  $("legend").hidden = !has;
  $("hint").hidden = !has;
  $("buildingName").textContent = has ? app.data.building : t("noBuilding");
  $("buildingMeta").textContent = has
    ? t("nodesEdges", { n: app.data.nodes.length, e: app.data.edges.length }) : "";
  $("resetBtn").disabled = !has;
  $("startSelect").disabled = !has;
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.disabled = !has;
    b.setAttribute("aria-checked", String(b.dataset.mode === app.mode));
  });
  $("hint").textContent = t(app.mode === "start" ? "hintStart" : "hintHazard");
  $("hint").dataset.mode = app.mode;
  renderLegend();
  if (lastErrors) showErrors(lastErrors);

  const result = has ? findRoutes(app.data, app) : { status: "noStart", routes: [] };
  app.routes = result.routes;
  const route = result.status === "ok" ? { status: "ok", ...result.routes[0] } : { status: result.status };
  // Drop a preview whose exit is no longer an alternative
  if (!app.routes.slice(1).some((r) => r.exit === app.preview)) app.preview = null;

  $("exportBtn").disabled = !has;
  renderStartSelect();
  renderRoute(route);
  renderHazards();
  if (has) renderMap(route);
  app.flash = null;
  saveProgress();
}

function applyStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  const lb = $("langBtn");
  // Switch is "on" in Bangla mode; the knob slides via CSS
  lb.dataset.lang = LANG;
  lb.setAttribute("aria-checked", String(LANG === "bn"));
  lb.setAttribute("aria-label", t("langSwitchLabel"));
  $("map").setAttribute("aria-label", t("mapLabel"));
  $("legend").setAttribute("aria-label", t("legend"));
  for (const [id, key] of [["exportBtn", "exportPng"], ["contrastBtn", "contrast"]]) {
    $(id).setAttribute("aria-label", t(key));
    $(id).title = t(key);
  }
  document.title = t("appName");
}

function typeName(type) { return t(type === "exit" ? "exitType" : type); }

function renderStartSelect() {
  const sel = $("startSelect");
  sel.innerHTML = "";
  sel.add(new Option(t("startPlaceholder"), ""));
  if (!app.data) return;
  app.data.nodes
    .filter((n) => n.type !== "exit")
    .forEach((n) => {
      const blocked = app.blockedNodes.has(n.id);
      sel.add(new Option(`${n.label} (${n.id})${blocked ? " — " + t("stateBlocked") : ""}`, n.id));
    });
  sel.value = app.start || "";
}

function renderMap(route) {
  const svg = $("map");
  svg.innerHTML = "";
  const { nodes, edges } = app.data;
  const R = 18;

  // Normalise coordinates to a fixed drawing size so nodes look the same for any dataset.
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1);
  const s = 760 / span;
  const pad = 50;
  const P = new Map(nodes.map((n) => [n.id, { x: (n.x - minX) * s + pad, y: (n.y - minY) * s + pad }]));
  const w = (Math.max(...xs) - minX) * s + pad * 2;
  const h = (Math.max(...ys) - minY) * s + pad * 2;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const onRoute = new Set(route.status === "ok" ? route.edgeIds : []);
  const routeNodes = new Set(route.status === "ok" ? route.path : []);
  const deadNode = (id) => app.blockedNodes.has(id) || app.closedExits.has(id);

  // A new route restarts the draw animation; an unchanged route stays still.
  const routeKey = route.status === "ok" ? route.path.join(">") : "";
  const routeChanged = routeKey !== app.lastRouteKey;
  app.lastRouteKey = routeKey;

  const gEdges = el("g", { class: "edges" });
  const gRoute = el("g", { class: "route-layer" });
  const gLabels = el("g", { class: "edge-labels" });
  edges.forEach((e) => {
    const a = P.get(e.from), b = P.get(e.to);
    const blocked = app.blockedEdges.has(e.id);
    const unusable = blocked || deadNode(e.from) || deadNode(e.to);
    const hazardMode = app.mode === "hazard";
    const g = el("g", {
      class: `edge${blocked ? " is-blocked" : ""}${unusable ? " is-unusable" : ""}${hazardMode ? " is-clickable" : ""}`,
      tabindex: hazardMode ? 0 : -1,
      role: "button",
      "aria-pressed": String(blocked),
      "aria-label": t("edgeAria", { id: e.id, from: e.from, to: e.to, cost: e.cost }) + (blocked ? `, ${t("stateBlocked")}` : ""),
    });
    g.append(
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "edge-hit" }),
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "edge-line" })
    );
    activate(g, () => onEdge(e.id));
    gEdges.appendChild(g);

    if (onRoute.has(e.id)) {
      // Draw in path direction so the animation flows start -> exit
      const idx = route.edgeIds.indexOf(e.id);
      const p = P.get(route.path[idx]), q = P.get(route.path[idx + 1]);
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      ["route-glow", "route-line"].forEach((cls) => {
        const seg = el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: cls + (routeChanged ? " draw" : "") });
        seg.style.setProperty("--len", len);
        seg.style.setProperty("--delay", `${idx * 100}ms`);
        gRoute.appendChild(seg);
      });
    }

    // Cost badge at the midpoint
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const txt = fmtNum(e.cost);
    const bw = 14 + String(txt).length * 7.5;
    const lab = el("g", { class: `cost${onRoute.has(e.id) ? " on-route" : ""}${blocked ? " is-blocked" : ""}`, "aria-hidden": "true" });
    lab.append(
      el("rect", { x: mx - bw / 2, y: my - 10, width: bw, height: 20, rx: 6 }),
      el("text", { x: mx, y: my + 4, "text-anchor": "middle" }, txt)
    );
    gLabels.appendChild(lab);
  });

  // Previewed alternative: dashed line under the main route
  const alt = app.routes.find((r) => r.exit === app.preview);
  if (alt) {
    const gAlt = el("g", { class: "alt-layer" });
    alt.path.slice(1).forEach((id, i) => {
      const p = P.get(alt.path[i]), q = P.get(id);
      gAlt.appendChild(el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: "alt-line" }));
    });
    gRoute.prepend(gAlt);
  }
  app.pos = P;

  const gNodes = el("g", { class: "nodes" });
  nodes.forEach((n) => {
    const { x, y } = P.get(n.id);
    const blocked = app.blockedNodes.has(n.id);
    const closed = app.closedExits.has(n.id);
    const isStart = app.start === n.id;
    const clickable = app.mode === "hazard" || n.type !== "exit";
    const cls = ["node", `t-${n.type}`];
    if (blocked) cls.push("is-blocked");
    if (closed) cls.push("is-closed");
    if (routeNodes.has(n.id)) cls.push("on-route");
    if (isStart) cls.push("is-start");
    if (route.status === "ok" && route.exit === n.id) cls.push("is-target");
    if (app.flash === n.id) cls.push("flash");
    if (clickable) cls.push("is-clickable");
    const state = blocked ? `, ${t("stateBlocked")}` : closed ? `, ${t("stateClosed")}` : "";
    const g = el("g", {
      class: cls.join(" "),
      transform: `translate(${x} ${y})`,
      tabindex: clickable ? 0 : -1,
      role: "button",
      "aria-label": t("nodeAria", { label: n.label, id: n.id, type: typeName(n.type) }) + state,
    });
    if (isStart) g.appendChild(el("circle", { r: R + 8, class: "start-ring" }));
    // Distinct shape per type: room = rounded square, junction = circle, exit = larger circle
    if (n.type === "room") g.appendChild(el("rect", { x: -R, y: -R, width: R * 2, height: R * 2, rx: 7, class: "shape" }));
    else if (n.type === "junction") g.appendChild(el("circle", { r: R - 2, class: "shape" }));
    else g.appendChild(el("circle", { r: R + 2, class: "shape" }));
    // Slash under the ID so the ID stays readable
    if (blocked || closed) g.appendChild(el("path", { d: `M${-(R - 5)} ${-(R - 5)}L${R - 5} ${R - 5}`, class: "slash" }));
    g.appendChild(el("text", { class: "node-id", y: 4, "text-anchor": "middle" }, n.id));
    g.appendChild(el("text", { class: "node-label", y: R + 18, "text-anchor": "middle" }, n.label));
    activate(g, () => onNode(n.id));
    gNodes.appendChild(g);
  });

  svg.append(gEdges, gRoute, gLabels, gNodes);
}

function el(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

const ICONS = {
  pin: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
  door: '<path d="M14 4h5v16h-5M10 8l4 4-4 4M14 12H4"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};
const svgIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

function renderRoute(route) {
  const body = $("routeBody");
  $("routeCard").dataset.status = route.status;
  const titleKey = { ok: "statusOk", noStart: "statusNoStart", noRoute: "statusNoRoute", startBlocked: "statusStartBlocked" }[route.status];
  const badgeCls = route.status === "ok" ? "ok" : route.status === "noStart" ? "idle" : "bad";

  // Badge only for success; failure states already show the status as their heading
  let html = `<div class="route-top"><h2 class="section-title">${t("routeTitle")}</h2>
    ${route.status === "ok" ? `<span class="badge ok">${t(titleKey)}</span>` : ""}</div>`;

  if (route.status === "ok") {
    const byId = new Map(app.data.nodes.map((n) => [n.id, n]));
    const costOf = new Map(app.data.edges.map((e) => [e.id, e.cost]));
    const exit = byId.get(route.exit);
    const steps = route.path.map((id, i) => {
      const n = byId.get(id);
      const cls = i === 0 ? "is-first" : id === route.exit ? "is-exit" : "";
      const segCost = i > 0 ? `+${fmtNum(costOf.get(route.edgeIds[i - 1]))}` : t("startLegend");
      return `<li class="step ${cls}" style="--i:${i}">
        <span class="step-dot" aria-hidden="true"></span>
        <span class="step-main"><span class="step-id">${esc(id)}</span><span class="step-label">${esc(n.label)}</span></span>
        <span class="step-cost">${segCost}</span></li>`;
    }).join("");
    html += `
      <div class="summary">
        <div class="cost-big"><span class="num">${fmtNum(route.cost)}</span><span class="cap">${t("totalCost")}</span></div>
        <div class="exit-to"><span class="exit-pill">${svgIcon("door")}${esc(exit.label)} · ${esc(exit.id)}</span>
          <span class="cap">${fmtNum(route.edgeIds.length)} ${t("corridors")}</span></div>
      </div>
      <div class="steps-title"><span>${t("path")}</span>
        <button type="button" class="link-btn" id="walkBtn">${svgIcon("play")}<span>${t("walk")}</span></button></div>
      <ol class="steps" id="steps" aria-label="${t("path")}">${steps}</ol>`;

    // Alternatives: best route to each other reachable exit
    const others = app.routes.slice(1);
    if (others.length) {
      html += `<div class="alts"><div class="steps-title"><span>${t("altTitle")}</span><span class="faint">${t("altHint")}</span></div>
        <ul class="alt-list">${others.map((r) => {
          const ex = byId.get(r.exit);
          return `<li><button type="button" class="alt-item" data-exit="${esc(r.exit)}" aria-pressed="${app.preview === r.exit}">
            <span class="alt-exit">${svgIcon("door")}${esc(ex.label)} · ${esc(r.exit)}</span>
            <span class="alt-cost">${fmtNum(r.cost)}<span class="alt-diff">+${fmtNum(r.cost - route.cost)}</span></span>
          </button></li>`;
        }).join("")}</ul></div>`;
    }
  } else {
    const icon = route.status === "noStart" ? "pin" : route.status === "noRoute" ? "ban" : "alert";
    html += `<div class="state"><span class="state-icon ${badgeCls}">${svgIcon(icon)}</span>
      <div><h3>${t(titleKey)}</h3><p>${t(titleKey + "Body")}</p></div></div>`;
  }
  body.innerHTML = html;
  if (route.status !== "ok") return;
  $("walkBtn").addEventListener("click", () => (walk ? stopWalk() : startWalk(route)));
  body.querySelectorAll(".alt-item").forEach((b) => b.addEventListener("click", () => {
    app.preview = app.preview === b.dataset.exit ? null : b.dataset.exit;
    render();
  }));
}

function renderHazards() {
  const box = $("hazardList");
  box.innerHTML = "";
  if (!app.data) return;
  const groups = [
    ["blockedNodes", app.blockedNodes, ""],
    ["blockedEdges", app.blockedEdges, ""],
    ["closedExits", app.closedExits, "closed"],
  ].filter(([, set]) => set.size);
  if (!groups.length) {
    box.innerHTML = `<p class="hz-empty">${svgIcon("check")}${t("hazardsNone")}</p>`;
    return;
  }
  groups.forEach(([key, set, extra]) => {
    const wrap = document.createElement("div");
    wrap.className = "hz-group";
    const h = document.createElement("p");
    h.className = "hz-label";
    h.textContent = t(key);
    const ul = document.createElement("ul");
    ul.className = "tags";
    [...set].sort().forEach((id) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tag ${extra}`;
      b.innerHTML = `${esc(id)}<span class="x" aria-hidden="true">×</span>`;
      b.setAttribute("aria-label", `${id}: ${t("undo")}`);
      b.onclick = () => { set.delete(id); app.flash = id; render(); };
      li.appendChild(b);
      ul.appendChild(li);
    });
    wrap.append(h, ul);
    box.appendChild(wrap);
  });
}

function renderLegend() {
  const items = [
    ["room", '<rect x="4" y="4" width="16" height="16" rx="4" class="lg-room"/>'],
    ["junction", '<circle cx="12" cy="12" r="7" class="lg-junction"/>'],
    ["exitType", '<circle cx="12" cy="12" r="8" class="lg-exit"/>'],
    ["startLegend", '<circle cx="12" cy="12" r="9" class="lg-start"/><circle cx="12" cy="12" r="4" class="lg-junction"/>'],
    ["routeLegend", '<path d="M3 12h18" class="lg-route"/>'],
    ["blocked", '<circle cx="12" cy="12" r="8" class="lg-blocked"/><path d="M7 7l10 10" class="lg-slash"/>'],
    ["closed", '<circle cx="12" cy="12" r="8" class="lg-closed"/><path d="M7 7l10 10" class="lg-slash-grey"/>'],
  ];
  $("legend").innerHTML = items.map(([k, s]) =>
    `<li><svg viewBox="0 0 24 24" aria-hidden="true">${s}</svg>${t(k)}</li>`).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- route walkthrough: a marker travels the route, the stepper follows ----------
let walk = null; // { raf, timer, dot }
const SEG_MS = 650;

function startWalk(route) {
  stopWalk();
  const pts = route.path.map((id) => app.pos.get(id));
  const steps = [...document.querySelectorAll("#steps .step")];
  const dot = el("g", { class: "walker", "aria-hidden": "true" });
  dot.append(el("circle", { r: 15, class: "walker-halo" }), el("circle", { r: 7, class: "walker-dot" }));
  $("map").appendChild(dot);
  const place = (p) => dot.setAttribute("transform", `translate(${p.x} ${p.y})`);
  const setStep = (k) => steps.forEach((s, j) => {
    s.classList.toggle("is-active", j === k);
    s.classList.toggle("is-done", j < k);
  });
  const btn = $("walkBtn");
  btn.innerHTML = `${svgIcon("stop")}<span>${t("walkStop")}</span>`;
  walk = { raf: 0, timer: 0, dot };
  const last = pts.length - 1;
  const finish = () => { place(pts[last]); setStep(last); walk.timer = setTimeout(stopWalk, 1400); };

  if (reduceMotion()) {
    // No movement: jump from step to step
    let k = 0;
    const tick = () => { place(pts[k]); setStep(k); if (k++ < last) walk.timer = setTimeout(tick, SEG_MS); else finish(); };
    return tick();
  }
  let t0 = null;
  const frame = (ts) => {
    if (t0 === null) t0 = ts;
    const progress = (ts - t0) / SEG_MS;
    const k = Math.floor(progress);
    if (k >= last) return finish();
    const f = progress - k;
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; // ease-in-out per corridor
    const a = pts[k], b = pts[k + 1];
    place({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });
    setStep(f > 0.9 ? k + 1 : k);
    walk.raf = requestAnimationFrame(frame);
  };
  walk.raf = requestAnimationFrame(frame);
}

function stopWalk() {
  if (!walk) return;
  cancelAnimationFrame(walk.raf);
  clearTimeout(walk.timer);
  walk.dot.remove();
  document.querySelectorAll("#steps .step").forEach((s) => s.classList.remove("is-active", "is-done"));
  const btn = $("walkBtn");
  if (btn) btn.innerHTML = `${svgIcon("play")}<span>${t("walk")}</span>`;
  walk = null;
}

// ---------- PNG export: inline computed styles so the image matches the screen ----------
function exportPng() {
  const svg = $("map");
  const vb = svg.viewBox.baseVal;
  const clone = svg.cloneNode(true);
  clone.querySelectorAll(".walker").forEach((n) => n.remove());
  const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
    "stroke-opacity", "opacity", "font-family", "font-size", "font-weight", "paint-order"];
  const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
  src.forEach((n, i) => {
    if (!dst[i]) return;
    const cs = getComputedStyle(n);
    dst[i].setAttribute("style", props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  // Add a header strip above the map for the building name
  const HEAD = 44;
  const W = vb.width, H = vb.height + HEAD;
  const body = el("g", { transform: `translate(0 ${HEAD})` });
  while (clone.firstChild) body.appendChild(clone.firstChild);
  clone.setAttribute("xmlns", SVGNS);
  clone.setAttribute("viewBox", `0 0 ${W} ${H}`);
  clone.setAttribute("width", W);
  clone.setAttribute("height", H);
  clone.removeAttribute("style");
  clone.append(
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "#ffffff" }),
    el("text", { x: 20, y: 30, style: "font: 600 16px Inter, 'Hind Siliguri', sans-serif; fill: #0a0a0b" }, app.data.building),
    el("line", { x1: 0, y1: HEAD - 0.5, x2: W, y2: HEAD - 0.5, style: "stroke: #e4e4e7; stroke-width: 1" }),
    body
  );

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = W * scale;
    c.height = H * scale;
    const ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${app.data.building.replace(/[^\wঀ-৿-]+/g, "_")}_route.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };
  img.src = url;
}

// ---------- saved progress (this browser only) ----------
const SAVE_KEY = "se-progress";
function saveProgress() {
  $("savedNote").hidden = !app.data;
  if (!app.data) return;
  const d = app.data;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      // Stored in the original file format so it is re-validated on load
      raw: { building: d.building, nodes: d.nodes, edges: d.edges,
        initial_state: { blocked_nodes: d.initial.blockedNodes, blocked_edges: d.initial.blockedEdges, closed_exits: d.initial.closedExits } },
      start: app.start, mode: app.mode,
      blockedNodes: [...app.blockedNodes], blockedEdges: [...app.blockedEdges], closedExits: [...app.closedExits],
    }));
  } catch (e) { /* storage unavailable: app still works, just not saved */ }
}
function restoreProgress() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return; }
  if (!s || !s.raw) return;
  const v = validateBuilding(s.raw);
  if (!v.ok) return;
  app.data = v.data;
  // Keep only IDs that still make sense for this building
  const type = new Map(v.data.nodes.map((n) => [n.id, n.type]));
  const edgeIds = new Set(v.data.edges.map((e) => e.id));
  const arr = (x) => (Array.isArray(x) ? x : []);
  app.blockedNodes = new Set(arr(s.blockedNodes).filter((id) => type.has(id) && type.get(id) !== "exit"));
  app.blockedEdges = new Set(arr(s.blockedEdges).filter((id) => edgeIds.has(id)));
  app.closedExits = new Set(arr(s.closedExits).filter((id) => type.get(id) === "exit"));
  app.start = type.has(s.start) && type.get(s.start) !== "exit" ? s.start : null;
  app.mode = s.mode === "hazard" ? "hazard" : "start";
}

// ---------- high contrast ----------
function setContrast(on) {
  document.documentElement.dataset.contrast = on ? "high" : "";
  $("contrastBtn").setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("se-contrast", on ? "1" : "0"); } catch (e) {}
}

// ---------- wiring ----------
$("fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let raw;
    try { raw = JSON.parse(reader.result); } catch (err) { return showErrors([{ key: "errJson", p: {} }]); }
    loadBuilding(raw);
  };
  reader.onerror = () => showErrors([{ key: "errJson", p: {} }]);
  reader.readAsText(f);
  e.target.value = ""; // allow re-importing the same file
});
const loadSample = () => loadBuilding(SAMPLE_BUILDING);
$("sampleBtn").addEventListener("click", loadSample);
$("emptySampleBtn").addEventListener("click", loadSample);
$("resetBtn").addEventListener("click", () => resetHazards());
$("exportBtn").addEventListener("click", exportPng);
$("contrastBtn").addEventListener("click", () => setContrast($("contrastBtn").getAttribute("aria-pressed") !== "true"));
$("langBtn").addEventListener("click", () => { setLang(LANG === "en" ? "bn" : "en"); render(); });
$("startSelect").addEventListener("change", (e) => { app.start = e.target.value || null; app.flash = app.start; render(); });
document.querySelectorAll(".seg-btn").forEach((b) =>
  b.addEventListener("click", () => { app.mode = b.dataset.mode; render(); }));

// Optional URL presets, e.g. ?start=R1&block=C2 (used for screenshots)
(function init() {
  setLang(LANG);
  const q = new URLSearchParams(location.search);
  if (q.has("start") || q.has("sample")) {
    loadBuilding(SAMPLE_BUILDING);
    if (q.get("start")) app.start = q.get("start");
    (q.get("block") || "").split(",").filter(Boolean).forEach((id) => app.blockedNodes.add(id));
    (q.get("close") || "").split(",").filter(Boolean).forEach((id) => app.closedExits.add(id));
    if (q.get("mode") === "hazard") app.mode = "hazard";
  } else {
    restoreProgress();
  }
  let hc = false;
  try { hc = localStorage.getItem("se-contrast") === "1"; } catch (e) {}
  setContrast(q.get("contrast") === "high" || hc);
  if (q.get("lang") === "bn" || q.get("lang") === "en") setLang(q.get("lang"));
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => $("langBtn").classList.add("ready")));
})();
