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
};

// ---------- loading ----------
function loadBuilding(raw, sourceName) {
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
  close.setAttribute("aria-label", "×");
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
  applyStaticText();
  const has = !!app.data;
  $("emptyState").hidden = has;
  $("map").toggleAttribute("hidden", !has); // SVG has no .hidden property
  $("buildingName").textContent = has ? app.data.building : t("noBuilding");
  $("buildingMeta").textContent = has
    ? t("nodesEdges", { n: app.data.nodes.length, e: app.data.edges.length }) : "";
  $("resetBtn").disabled = !has;
  $("startSelect").disabled = !has;
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.disabled = !has;
    b.setAttribute("aria-checked", String(b.dataset.mode === app.mode));
  });
  $("hint").textContent = t(app.mode === "start" ? "hintStart" : "hintHazard");
  renderLegend();
  if (lastErrors) showErrors(lastErrors);
  if (!has) { $("routeBody").innerHTML = ""; $("hazardList").innerHTML = ""; return; }

  const route = findRoute(app.data, app);
  renderStartSelect();
  renderMap(route);
  renderRoute(route);
  renderHazards();
  app.flash = null;
}

function applyStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  const lb = $("langBtn");
  lb.textContent = t("langSwitch");
  lb.setAttribute("aria-label", t("langSwitchLabel"));
  lb.lang = LANG === "en" ? "bn" : "en";
  $("map").setAttribute("aria-label", t("mapLabel"));
  $("legend").setAttribute("aria-label", t("legend"));
  document.title = t("appName");
}

function typeName(type) { return t(type === "exit" ? "exitType" : type); }

function renderStartSelect() {
  const sel = $("startSelect");
  sel.innerHTML = "";
  const ph = new Option(t("startPlaceholder"), "");
  sel.add(ph);
  app.data.nodes
    .filter((n) => n.type !== "exit")
    .forEach((n) => {
      const blocked = app.blockedNodes.has(n.id);
      const o = new Option(`${n.label} (${n.id})${blocked ? " — " + t("stateBlocked") : ""}`, n.id);
      sel.add(o);
    });
  sel.value = app.start || "";
}

function renderMap(route) {
  const svg = $("map");
  svg.innerHTML = "";
  const { nodes, edges } = app.data;
  const R = 20;
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const pad = 46;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
  svg.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`);

  const pos = new Map(nodes.map((n) => [n.id, n]));
  const onRoute = new Set(route.status === "ok" ? route.edgeIds : []);
  const routeNodes = new Set(route.status === "ok" ? route.path : []);
  const deadNode = (id) => app.blockedNodes.has(id) || app.closedExits.has(id);

  // A new route key restarts the draw animation; unchanged routes stay still.
  const routeKey = route.status === "ok" ? route.path.join(">") : "";
  const routeChanged = routeKey !== app.lastRouteKey;
  app.lastRouteKey = routeKey;

  const gEdges = el("g", { class: "edges" });
  const gRoute = el("g", { class: "route-layer" });
  const gLabels = el("g", { class: "edge-labels" });
  edges.forEach((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const blocked = app.blockedEdges.has(e.id);
    const unusable = blocked || deadNode(e.from) || deadNode(e.to);
    const g = el("g", {
      class: `edge${blocked ? " is-blocked" : ""}${unusable ? " is-unusable" : ""}${app.flash === e.id ? " flash" : ""}${app.mode === "hazard" ? " is-clickable" : ""}`,
      tabindex: app.mode === "hazard" ? 0 : -1,
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
      // Draw route segment in path direction so the animation flows start -> exit
      const idx = route.edgeIds.indexOf(e.id);
      const p = pos.get(route.path[idx]), q = pos.get(route.path[idx + 1]);
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const seg = el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: "route-line" + (routeChanged ? " draw" : "") });
      seg.style.setProperty("--len", len);
      seg.style.setProperty("--delay", `${idx * 110}ms`);
      gRoute.appendChild(seg);
    }

    // Cost badge at the midpoint
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const txt = fmtNum(e.cost);
    const bw = 10 + String(txt).length * 8;
    const lab = el("g", { class: `cost${onRoute.has(e.id) ? " on-route" : ""}${blocked ? " is-blocked" : ""}`, "aria-hidden": "true" });
    lab.append(
      el("rect", { x: mx - bw / 2, y: my - 10, width: bw, height: 20, rx: 10 }),
      el("text", { x: mx, y: my + 4.5, "text-anchor": "middle" }, txt)
    );
    if (blocked) {
      lab.append(el("path", { d: `M${mx - 5} ${my - 21}l10 10m0 -10l-10 10`, class: "x-mark" }));
    }
    gLabels.appendChild(lab);
  });

  const gNodes = el("g", { class: "nodes" });
  nodes.forEach((n) => {
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
      transform: `translate(${n.x} ${n.y})`,
      tabindex: clickable ? 0 : -1,
      role: "button",
      "aria-label": t("nodeAria", { label: n.label, id: n.id, type: typeName(n.type) }) + state,
    });
    if (isStart) g.appendChild(el("circle", { r: R + 7, class: "start-ring" }));
    // Distinct shape per type: room = rounded square, junction = circle, exit = larger circle
    if (n.type === "room") g.appendChild(el("rect", { x: -R, y: -R, width: R * 2, height: R * 2, rx: 6, class: "shape" }));
    else if (n.type === "junction") g.appendChild(el("circle", { r: R - 3, class: "shape" }));
    else g.appendChild(el("circle", { r: R + 2, class: "shape" }));
    // Slash under the ID so the ID stays readable
    if (blocked || closed) g.appendChild(el("path", { d: `M-${R - 4} -${R - 4}L${R - 4} ${R - 4}`, class: "slash" }));
    g.appendChild(el("text", { class: "node-id", y: 4.5, "text-anchor": "middle" }, n.id));
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

function renderRoute(route) {
  const body = $("routeBody");
  const card = $("routeCard");
  card.dataset.status = route.status;
  const icon = {
    ok: '<path d="M5 12l5 5 9-10" />',
    noStart: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>',
    noRoute: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    startBlocked: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  }[route.status];
  const titleKey = { ok: "statusOk", noStart: "statusNoStart", noRoute: "statusNoRoute", startBlocked: "statusStartBlocked" }[route.status];
  let html = `<div class="status"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><strong>${t(titleKey)}</strong></div>`;
  if (route.status === "ok") {
    const byId = new Map(app.data.nodes.map((n) => [n.id, n]));
    const chips = route.path.map((id, i) =>
      `<li class="chip t-${byId.get(id).type}" style="--i:${i}" title="${esc(byId.get(id).label)}">${esc(id)}</li>`
    ).join('<li class="arrow" aria-hidden="true">→</li>');
    const exit = byId.get(route.exit);
    html += `
      <div class="stats">
        <div><span class="stat-label">${t("totalCost")}</span><span class="stat-big">${fmtNum(route.cost)}</span></div>
        <div><span class="stat-label">${t("exit")}</span><span class="stat-mid">${esc(exit.label)} <span class="mono">(${esc(exit.id)})</span></span>
          <span class="muted small">${fmtNum(route.edgeIds.length)} ${t("corridors")}</span></div>
      </div>
      <span class="stat-label">${t("path")}</span>
      <ol class="chips" aria-label="${t("path")}">${chips}</ol>`;
  } else {
    const bodyKey = titleKey + "Body";
    html += `<p class="muted">${t(bodyKey)}</p>`;
  }
  body.innerHTML = html;
}

function renderHazards() {
  const box = $("hazardList");
  const groups = [
    ["blockedNodes", app.blockedNodes, (id) => app.blockedNodes.delete(id)],
    ["blockedEdges", app.blockedEdges, (id) => app.blockedEdges.delete(id)],
    ["closedExits", app.closedExits, (id) => app.closedExits.delete(id)],
  ].filter(([, set]) => set.size);
  box.innerHTML = "";
  if (!groups.length) {
    box.innerHTML = `<p class="muted">${t("hazardsNone")}</p>`;
    return;
  }
  groups.forEach(([key, set, remove]) => {
    const h = document.createElement("p");
    h.className = "stat-label";
    h.textContent = t(key);
    const ul = document.createElement("ul");
    ul.className = "tags";
    [...set].sort().forEach((id) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tag";
      b.innerHTML = `${esc(id)} <span aria-hidden="true">×</span>`;
      b.setAttribute("aria-label", `${id} — ${t(key === "closedExits" ? "stateClosed" : "stateBlocked")} ×`);
      b.onclick = () => { remove(id); app.flash = id; render(); };
      li.appendChild(b);
      ul.appendChild(li);
    });
    box.append(h, ul);
  });
}

function renderLegend() {
  const items = [
    ["room", '<rect x="3" y="3" width="18" height="18" rx="4" class="lg-room"/>'],
    ["junction", '<circle cx="12" cy="12" r="8" class="lg-junction"/>'],
    ["exitType", '<circle cx="12" cy="12" r="10" class="lg-exit"/>'],
    ["startLegend", '<circle cx="12" cy="12" r="10" class="lg-start"/><circle cx="12" cy="12" r="5" class="lg-junction"/>'],
    ["routeLegend", '<path d="M2 12h20" class="lg-route"/>'],
    ["blocked", '<circle cx="12" cy="12" r="9" class="lg-blocked"/><path d="M6 6l12 12" class="lg-slash"/>'],
    ["closed", '<circle cx="12" cy="12" r="10" class="lg-closed"/><path d="M5 5l14 14" class="lg-slash"/>'],
  ];
  $("legend").innerHTML = items.map(([k, s]) =>
    `<li><svg viewBox="0 0 24 24" aria-hidden="true">${s}</svg>${t(k)}</li>`).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- wiring ----------
$("fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let raw;
    try { raw = JSON.parse(reader.result); } catch (err) { return showErrors([{ key: "errJson", p: {} }]); }
    loadBuilding(raw, f.name);
  };
  reader.onerror = () => showErrors([{ key: "errJson", p: {} }]);
  reader.readAsText(f);
  e.target.value = ""; // allow re-importing the same file
});
$("sampleBtn").addEventListener("click", () => loadBuilding(SAMPLE_BUILDING, "building.json"));
$("resetBtn").addEventListener("click", () => resetHazards());
$("langBtn").addEventListener("click", () => { setLang(LANG === "en" ? "bn" : "en"); render(); });
$("startSelect").addEventListener("change", (e) => { app.start = e.target.value || null; app.flash = app.start; render(); });
document.querySelectorAll(".mode-btn").forEach((b) =>
  b.addEventListener("click", () => { app.mode = b.dataset.mode; render(); }));

// Optional URL presets, e.g. ?start=R1&block=C2 (used for screenshots)
(function init() {
  setLang(LANG);
  const q = new URLSearchParams(location.search);
  if (q.has("start") || q.has("sample")) {
    loadBuilding(SAMPLE_BUILDING, "building.json");
    if (q.get("start")) app.start = q.get("start");
    (q.get("block") || "").split(",").filter(Boolean).forEach((id) => app.blockedNodes.add(id));
    if (q.get("lang") === "bn") setLang("bn");
  }
  render();
})();
