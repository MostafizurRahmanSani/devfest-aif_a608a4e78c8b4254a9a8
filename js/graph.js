// Validation + routing engine. Pure functions, no DOM.

// Returns { ok: true, data } or { ok: false, errors: [{ key, p }] }
function validateBuilding(raw) {
  const errors = [];
  const err = (key, p) => errors.push({ key, p: p || {} });
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const isStr = (v) => typeof v === "string" && v.trim() !== "";

  if (!isObj(raw)) { err("errNotObject"); return { ok: false, errors }; }
  if (!isStr(raw.building)) err("errBuilding");
  if (!Array.isArray(raw.nodes)) err("errNodesArray");
  if (!Array.isArray(raw.edges)) err("errEdgesArray");
  if (!isObj(raw.initial_state)) err("errInitialState");
  // Stop only when the structure itself is unusable
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !isObj(raw.initial_state))
    return { ok: false, errors };

  const { nodes, edges } = raw;
  if (nodes.length < 2 || nodes.length > 60) err("errNodeCount", { n: nodes.length });
  if (edges.length < 1 || edges.length > 150) err("errEdgeCount", { n: edges.length });

  const byId = new Map();
  nodes.forEach((n, i) => {
    if (!isObj(n)) return err("errNodeShape", { i });
    if (!isStr(n.id)) return err("errNodeId", { i });
    if (byId.has(n.id)) err("errDupNode", { id: n.id });
    if (!isStr(n.label)) err("errNodeLabel", { id: n.id });
    if (!["room", "junction", "exit"].includes(n.type)) err("errNodeType", { id: n.id });
    if (typeof n.x !== "number" || !isFinite(n.x) || typeof n.y !== "number" || !isFinite(n.y))
      err("errNodeXY", { id: n.id });
    byId.set(n.id, n);
  });
  const types = [...byId.values()].map((n) => n.type);
  if (!types.includes("exit")) err("errNoExit");
  if (!types.some((t) => t === "room" || t === "junction")) err("errNoRoom");

  const edgeIds = new Set();
  const pairs = new Set();
  edges.forEach((e, i) => {
    if (!isObj(e)) return err("errEdgeShape", { i });
    if (!isStr(e.id)) return err("errEdgeId", { i });
    if (edgeIds.has(e.id)) err("errDupEdge", { id: e.id });
    edgeIds.add(e.id);
    if (!byId.has(e.from) || !byId.has(e.to)) return err("errEdgeEnds", { id: e.id });
    if (e.from === e.to) return err("errSelfLoop", { id: e.id });
    const key = [e.from, e.to].sort().join("\u0000");
    if (pairs.has(key)) err("errDupPair", { id: e.id });
    pairs.add(key);
    if (!Number.isInteger(e.cost) || e.cost <= 0) err("errCost", { id: e.id });
  });

  const st = raw.initial_state;
  ["blocked_nodes", "blocked_edges", "closed_exits"].forEach((k) => {
    if (!Array.isArray(st[k])) return err("errStateArray", { k });
    st[k].forEach((id) => {
      if (k === "blocked_edges") {
        if (!edgeIds.has(id)) err("errStateRef", { k, id: String(id) });
      } else {
        const n = byId.get(id);
        if (!n) err("errStateRef", { k, id: String(id) });
        else if (k === "blocked_nodes" && n.type === "exit") err("errStateCat", { k, id });
        else if (k === "closed_exits" && n.type !== "exit") err("errStateCat", { k, id });
      }
    });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      building: raw.building,
      nodes: nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, x: n.x, y: n.y })),
      edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, cost: e.cost })),
      initial: {
        blockedNodes: [...st.blocked_nodes],
        blockedEdges: [...st.blocked_edges],
        closedExits: [...st.closed_exits],
      },
    },
  };
}

// Dijkstra over the usable graph. adj: Map id -> [{to, cost}]
function dijkstra(adj, source) {
  const dist = new Map([[source, 0]]);
  const done = new Set();
  // Graphs are tiny (<=60 nodes), so a linear scan is simple and fast enough.
  while (true) {
    let u = null;
    for (const [id, d] of dist) if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
    if (u === null) break;
    done.add(u);
    for (const { to, cost } of adj.get(u) || []) {
      const nd = dist.get(u) + cost;
      if (!dist.has(to) || nd < dist.get(to)) dist.set(to, nd);
    }
  }
  return dist;
}

// state: { start, blockedNodes:Set, blockedEdges:Set, closedExits:Set }
// Returns { status: "noStart"|"startBlocked"|"noRoute"|"ok", path, exit, cost, edgeIds }
function findRoute(data, state) {
  const { start } = state;
  if (!start) return { status: "noStart" };
  const unusable = (id) => state.blockedNodes.has(id) || state.closedExits.has(id);
  if (unusable(start)) return { status: "startBlocked" };

  const adj = new Map(data.nodes.map((n) => [n.id, []]));
  for (const e of data.edges) {
    if (state.blockedEdges.has(e.id) || unusable(e.from) || unusable(e.to)) continue;
    adj.get(e.from).push({ to: e.to, cost: e.cost, edge: e.id });
    adj.get(e.to).push({ to: e.from, cost: e.cost, edge: e.id });
  }

  const fromStart = dijkstra(adj, start);
  // Cheapest open exit; ties -> smallest exit ID
  let best = null;
  for (const n of data.nodes) {
    if (n.type !== "exit" || !fromStart.has(n.id)) continue;
    const d = fromStart.get(n.id);
    if (!best || d < best.cost || (d === best.cost && n.id < best.exit)) best = { exit: n.id, cost: d };
  }
  if (!best) return { status: "noRoute" };

  // Walk forward picking the smallest next ID that stays on a shortest path,
  // which yields the lexicographically smallest node sequence among ties.
  const toExit = dijkstra(adj, best.exit);
  const path = [start];
  const edgeIds = [];
  let u = start;
  while (u !== best.exit) {
    let next = null;
    for (const a of adj.get(u)) {
      if (!toExit.has(a.to)) continue;
      if (fromStart.get(u) + a.cost + toExit.get(a.to) !== best.cost) continue;
      if (!next || a.to < next.to) next = a;
    }
    path.push(next.to);
    edgeIds.push(next.edge);
    u = next.to;
  }
  return { status: "ok", path, exit: best.exit, cost: best.cost, edgeIds };
}

if (typeof module !== "undefined") module.exports = { validateBuilding, findRoute };
