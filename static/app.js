/* SF Housing & Rent Trend Explorer — frontend logic.
   Charts follow the dataviz method: 2px lines, ≥8px hover markers with a
   surface ring, hairline grids, legend only for ≥2 series, table view for
   every chart, colors assigned to a neighborhood when added (never repainted
   as the selection changes). */

"use strict";

// ---------------------------------------------------------------------------
// State

const MAX_HOODS = 3;
const state = {
  allHoods: [],            // [{name, assessor_rows, eviction_rows, cached}]
  selected: [],            // [{name, slot}]  slot ∈ 0..2 — sticky per hood
  use: "res",
  data: null,              // /api/trends response .hoods
  rent: null,              // /api/rent response
  map: null,               // /api/rentmap response (heat map)
  charts: {},              // Chart instances by key
  rentCharts: {},          // sparkline Chart instances by hood
  requestToken: 0,
  rentToken: 0,
  pollTimer: null,
};

const ZIP_RE = /^94\d{3}$/;
const FEATURED_HOODS = [
  { name: "Portola", label: "Portola" },
  { name: "Bernal Heights", label: "Bernal Heights" },
  { name: "Marina", label: "Marina" },
  { name: "Pacific Heights", label: "Pacific Heights" },
  { name: "Twin Peaks", label: "Twin Peaks" },
  { name: "West of Twin Peaks", label: "West Portal" },
];

function normalizeHoodName(name) {
  const trimmed = name.trim();
  const match = FEATURED_HOODS.find((hood) =>
    hood.name.toLowerCase() === trimmed.toLowerCase() ||
    hood.label.toLowerCase() === trimmed.toLowerCase());
  return match?.name || trimmed;
}

function displayHoodName(name) {
  return FEATURED_HOODS.find((hood) => hood.name === name)?.label || name;
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------------------
// Theme / palette plumbing

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function slotColor(slot) {
  return cssVar(`--series-${slot + 1}`);
}
function applyChartDefaults() {
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssVar("--text-muted");
  Chart.defaults.borderColor = cssVar("--grid");
  Chart.defaults.animation = { duration: 250 };
}

// ---------------------------------------------------------------------------
// Formatting

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
function fmtMoney(n) {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n);
}
const fmtMoneyFull = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const pct = (a, b) => (a == null || !b ? null : ((a - b) / b) * 100);

// --- Motion helpers

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Count a number up from 0 → target with easeOutCubic, formatting each frame.
function countUp(node, target, fmt, dur = 720) {
  if (REDUCED || target == null || !isFinite(target)) {
    node.textContent = fmt(target);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    node.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
    else node.textContent = fmt(target);
  };
  requestAnimationFrame(step);
}

// Stagger a freshly-appended card into view.
function staggerIn(node, i) {
  if (REDUCED) return;
  node.classList.add("enter");
  node.style.setProperty("--enter-i", i);
}

// Chart.js option block that draws a line on progressively, left → right.
function progressiveDraw(pointCount, total = 900) {
  if (REDUCED || !pointCount) return false;
  const per = total / pointCount;
  const seen = {};
  const ease = (ctx, axis) => {
    const key = axis + ctx.datasetIndex + "_" + ctx.index;
    if (ctx.type !== "data" || seen[key]) return 0;
    seen[key] = true;
    return ctx.index * per;
  };
  return {
    x: { type: "number", easing: "linear", duration: per, from: NaN,
         delay: (ctx) => ease(ctx, "x") },
    y: { type: "number", easing: "linear", duration: per,
         from: (ctx) => ctx.chart.scales.y.getPixelForValue(ctx.chart.scales.y.min),
         delay: (ctx) => ease(ctx, "y") },
  };
}

// ---------------------------------------------------------------------------
// Status line (shared progress / error display)

function showStatus(msg, { progress = null, error = false } = {}) {
  const box = $("#status");
  box.hidden = false;
  box.classList.toggle("error", error);
  box.textContent = "";
  box.append(el("span", null, msg));
  if (progress != null) {
    const bar = el("div", "bar");
    const fill = el("span");
    fill.style.width = Math.round(progress * 100) + "%";
    bar.append(fill);
    box.append(bar);
  }
}
function hideStatus() {
  $("#status").hidden = true;
  $("#status").classList.remove("error");
}

// ---------------------------------------------------------------------------
// Neighborhood picker

async function loadHoodList() {
  const res = await fetch("/api/neighborhoods");
  if (!res.ok) throw new Error((await res.json()).error || "failed to load neighborhoods");
  state.allHoods = (await res.json()).neighborhoods
    .filter((h) => FEATURED_HOODS.some((featured) => featured.name === h.name));
  rebuildDatalist();
}

function rebuildDatalist() {
  const dl = $("#hood-options");
  dl.textContent = "";
  for (const h of state.allHoods) {
    const opt = document.createElement("option");
    opt.value = displayHoodName(h.name);
    dl.append(opt);
  }
}

function hoodInfo(name) {
  return state.allHoods.find((h) => h.name === name);
}

function freeSlot() {
  const used = new Set(state.selected.map((s) => s.slot));
  for (let i = 0; i < MAX_HOODS; i++) if (!used.has(i)) return i;
  return 0;
}

function addHood(name) {
  name = normalizeHoodName(name);
  const zip = ZIP_RE.test(name);
  const featured = FEATURED_HOODS.some((hood) => hood.name === name);
  if (zip && state.map && !state.map.features.some((f) => f.zip === name)) {
    showStatus(`${name} isn't an SF ZIP I have data for.`, { error: true });
    return;
  }
  if (!zip && !featured && !hoodInfo(name)) {
    showStatus(`"${name}" isn't one of the six neighborhoods — pick one above.`, { error: true });
    return;
  }
  if (state.selected.some((s) => s.name === name)) return;
  if (state.selected.length >= MAX_HOODS) {
    showStatus(`Compare mode holds ${MAX_HOODS} areas — remove one first.`, { error: true });
    return;
  }
  state.selected.push({ name, slot: freeSlot() });
  $("#hood-input").value = "";
  renderChips();
  updateTrends();
}

function removeHood(name) {
  state.selected = state.selected.filter((s) => s.name !== name);
  renderChips();
  updateTrends();
}

function chipLabel(name) {
  return ZIP_RE.test(name) ? `ZIP ${name}` : displayHoodName(name);
}

function renderChips() {
  const box = $("#hood-chips");
  box.textContent = "";
  for (const s of state.selected) {
    const zip = ZIP_RE.test(s.name);
    const chip = el("span", "chip");
    const dot = el("span", "dot");
    dot.style.background = slotColor(s.slot);
    chip.append(dot, el("span", null, chipLabel(s.name)));
    if (zip) {
      const hoods = state.map?.features.find((f) => f.zip === s.name)?.hoods || [];
      chip.append(el("span", "meta", hoods.length ? hoods.join(" · ") : "exact ZIP"));
    } else {
      const info = hoodInfo(s.name) || {};
      chip.append(el("span", "meta", `${fmtInt(info.assessor_rows)} records`));
    }
    const refresh = el("button", null, "↻");
    refresh.title = "Re-download this area's data";
    refresh.onclick = () => refreshHood(s.name);
    const close = el("button", null, "×");
    close.title = "Remove";
    close.onclick = () => removeHood(s.name);
    chip.append(refresh, close);
    box.append(chip);
  }
  document.querySelectorAll(".quick-hood").forEach((button) => {
    const active = state.selected.some((selected) => selected.name === button.dataset.hood);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  updateMapSelection();
}

// ---------------------------------------------------------------------------
// Rent heat map (the pre-search view; ZORI by ZIP over TIGERweb boundaries)

// Sequential blue ramp (validated dataviz palette, steps 100→700).
const SEQ_RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec",
                  "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab",
                  "#184f95", "#104281", "#0d366b"];

async function loadMap() {
  const status = $("#map-status");
  status.hidden = false;
  status.textContent = "Loading the rent map (boundaries come from the Census, once)…";
  try {
    const res = await fetch("/api/rentmap");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.map = body;
    status.hidden = true;
    renderMap();
    rebuildDatalist();
  } catch (e) {
    status.classList.add("error");
    status.textContent = `Couldn't load the rent map: ${e.message}`;
  }
}

function renderMap() {
  const box = $("#map-box");
  box.textContent = "";
  if (!state.map) return;
  const feats = state.map.features.filter((f) => f.geometry);
  if (!feats.length) return;

  // --- equirectangular projection over the joint bounding box
  const pts = [];
  const ringsOf = (g) =>
    g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
  for (const f of feats) for (const ring of ringsOf(f.geometry)) pts.push(...ring);
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const W = 760;
  const s = W / ((maxLon - minLon) * kx);
  const H = Math.round((maxLat - minLat) * s);
  const px = (lon) => (lon - minLon) * kx * s;
  const py = (lat) => (maxLat - lat) * s;

  const vals = feats.map((f) => f.value).filter((v) => v != null);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  const rampColor = (v) =>
    SEQ_RAMP[Math.round(((v - vMin) / (vMax - vMin || 1)) * (SEQ_RAMP.length - 1))];

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Map of SF ZIP codes shaded by typical asking rent");
  const tip = $("#map-tip");
  state.mapShapes = {};

  const labelLayer = document.createElementNS(svg.namespaceURI, "g");
  for (const f of feats) {
    let d = "";
    let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    for (const ring of ringsOf(f.geometry)) {
      d += ring.map((p, i) => {
        const x = px(p[0]), y = py(p[1]);
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join("") + "Z";
    }
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill-rule", "evenodd");
    path.classList.add("zip-shape");
    const has = f.value != null;
    if (has) {
      path.setAttribute("fill", rampColor(f.value));
      path.addEventListener("click", () => addHood(f.zip));
    } else {
      path.setAttribute("fill", "var(--wash)");
      path.classList.add("nodata");
    }
    path.addEventListener("mousemove", (ev) => {
      tip.hidden = false;
      tip.innerHTML = "";
      tip.append(el("div", "t-zip", f.zip));
      tip.append(el("div", "t-rent", has
        ? `${fmtMoneyFull(f.value)}/mo typical asking` +
          (f.yoy != null ? ` · ${f.yoy >= 0 ? "+" : ""}${f.yoy}% YoY` : "")
        : "No rent-index coverage"));
      if (f.hoods.length) tip.append(el("div", "t-hoods", f.hoods.join(" · ")));
      const w = tip.offsetWidth || 200;
      tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - w - 12) + "px";
      tip.style.top = (ev.clientY + 16) + "px";
    });
    path.addEventListener("mouseleave", () => { tip.hidden = true; });
    svg.append(path);
    state.mapShapes[f.zip] = path;

    // label the polygons big enough to hold text (ink picked by fill depth);
    // the cramped downtown cluster falls back to tooltips
    if (has && bx1 - bx0 > 74 && by1 - by0 > 42) {
      const t = (f.value - vMin) / (vMax - vMin || 1);
      const ink = t > 0.55 ? "#ffffff" : "#0d366b";
      const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
      const label = document.createElementNS(svg.namespaceURI, "text");
      label.classList.add("zip-label");
      label.setAttribute("x", cx); label.setAttribute("y", cy - 2);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "12");
      label.setAttribute("fill", ink);
      label.textContent = f.zip;
      const val = document.createElementNS(svg.namespaceURI, "text");
      val.classList.add("zip-label");
      val.setAttribute("x", cx); val.setAttribute("y", cy + 12);
      val.setAttribute("text-anchor", "middle");
      val.setAttribute("font-size", "11");
      val.setAttribute("fill", ink);
      // one decimal — the citywide range is only ~$3-6.5K, whole-K rounding misleads
      val.innerHTML = `<tspan class="val">$${(f.value / 1000).toFixed(1)}K</tspan>`;
      labelLayer.append(label, val);
    }
  }
  svg.append(labelLayer);
  box.append(svg);

  const legend = $("#map-legend");
  legend.hidden = false;
  $("#legend-min").textContent = fmtMoneyFull(vMin) + "/mo";
  $("#legend-max").textContent = fmtMoneyFull(vMax) + "/mo";
  updateMapSelection();
}

function updateMapSelection() {
  if (!state.mapShapes) return;
  const chosen = new Set(state.selected.map((s) => s.name));
  for (const [zip, path] of Object.entries(state.mapShapes)) {
    path.classList.toggle("selected", chosen.has(zip));
  }
}

// ---------------------------------------------------------------------------
// Data loading with download progress

function startPolling(hoods) {
  stopPolling();
  const phases = { assessor: "property records", evictions: "eviction notices" };
  state.pollTimer = setInterval(async () => {
    for (const name of hoods) {
      try {
        const p = await (await fetch(`/api/progress?hood=${encodeURIComponent(name)}`)).json();
        if (p.phase === "assessor" && p.total) {
          showStatus(
            `Downloading ${name} — ${fmtInt(p.fetched)} of ~${fmtInt(p.total)} ${phases.assessor}…`,
            { progress: p.fetched / p.total });
          return;
        }
        if (p.phase === "evictions") {
          showStatus(`Downloading ${name} — ${phases.evictions}…`, { progress: 0.95 });
          return;
        }
      } catch { /* server busy with the download itself — fine */ }
    }
  }, 900);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function updateTrends() {
  const token = ++state.requestToken;
  const names = state.selected.map((s) => s.name);
  if (!names.length) {
    state.data = null;
    stopPolling();
    showStatus("Type a neighborhood or ZIP above — or click a ZIP on the map below.");
    renderAll();
    return;
  }
  const uncached = names.filter((n) => !ZIP_RE.test(n) && !(hoodInfo(n) || {}).cached);
  if (uncached.length) {
    showStatus(`Contacting DataSF for ${uncached.join(", ")}…`, { progress: 0 });
    startPolling(uncached);
  } else {
    showStatus("Loading…");
  }
  try {
    const qs = `hoods=${encodeURIComponent(names.join("|"))}&use=${state.use}`;
    const res = await fetch(`/api/trends?${qs}`);
    const body = await res.json();
    if (token !== state.requestToken) return; // superseded by a newer request
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.data = body.hoods;
    for (const n of names) {
      const info = hoodInfo(n);
      if (info) info.cached = true;
    }
    hideStatus();
    renderAll();
  } catch (e) {
    if (token !== state.requestToken) return;
    showStatus(`Couldn't load data: ${e.message}`, { error: true });
  } finally {
    if (token === state.requestToken) stopPolling();
  }
  // Only the freshest request drives the rent panel, and always with the
  // *current* selection (an older call's closure list could be stale).
  if (token === state.requestToken) {
    loadRent(state.selected.map((s) => s.name));
  }
}

async function loadRent(names) {
  const token = ++state.rentToken;
  const status = $("#rent-status");
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "Loading rent index…";
  try {
    const res = await fetch(`/api/rent?hoods=${encodeURIComponent(names.join("|"))}`);
    const body = await res.json();
    if (token !== state.rentToken) return;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.rent = body;
    status.hidden = true;
    renderRent();
  } catch (e) {
    if (token !== state.rentToken) return;
    status.classList.add("error");
    status.textContent = `Couldn't load rent benchmark: ${e.message}`;
  }
}

async function refreshRent() {
  const names = state.selected.map((s) => s.name);
  const status = $("#rent-status");
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "Re-downloading rent index from Zillow / Apartment List…";
  try {
    const res = await fetch("/api/refresh_rent", { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    if (names.length) await loadRent(names);
    else status.hidden = true;
  } catch (e) {
    status.classList.add("error");
    status.textContent = `Refresh failed: ${e.message}`;
  }
}

async function refreshHood(name) {
  showStatus(`Re-downloading ${name} from DataSF…`, { progress: 0 });
  startPolling([name]);
  try {
    const res = await fetch(`/api/refresh?hood=${encodeURIComponent(name)}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    hideStatus();
    await updateTrends();
  } catch (e) {
    showStatus(`Refresh failed: ${e.message}`, { error: true });
  } finally {
    stopPolling();
  }
}

// ---------------------------------------------------------------------------
// Rendering

function renderAll() {
  renderTiles();
  renderRent();
  renderValuesChart();
  renderEvictionsChart();
  renderReasonsChart();
  const has = !!state.data && state.selected.length > 0;
  for (const id of ["tiles", "card-rent", "card-values", "card-evictions", "card-reasons"]) {
    document.getElementById(id).style.display = has ? "" : "none";
  }
  // ZIP-only selections have no assessor data — drop the values card entirely
  if (has && !seriesEntries().some((e) => e.d.values.length)) {
    document.getElementById("card-values").style.display = "none";
  }
}

function seriesEntries() {
  // selection order, with data attached; skips hoods whose data isn't loaded yet
  return state.selected
    .filter((s) => state.data && state.data[s.name])
    .map((s) => ({ ...s, d: state.data[s.name] }));
}

// --- Summary tiles

function renderTiles() {
  const box = $("#tiles");
  box.textContent = "";
  for (const { name, slot, d } of seriesEntries()) {
    const withStats = d.values.filter((v) => v.median != null);
    const latest = withStats[withStats.length - 1];
    const fiveBack = latest && withStats.find((v) => v.year === latest.year - 5);
    const change = latest && fiveBack ? pct(latest.median, fiveBack.median) : null;

    const fullYears = d.evictions.filter((e) => !e.partial);
    const evLatest = fullYears[fullYears.length - 1];
    const evPrev = evLatest && fullYears.find((e) => e.year === evLatest.year - 1);

    const tile = el("div", "tile");
    tile.style.setProperty("--tile-color", slotColor(slot));
    const h = el("h3");
    const dot = el("span", "dot");
    dot.style.background = slotColor(slot);
    h.append(dot, el("span", null, chipLabel(name)));
    tile.append(h);

    const stats = el("div", "stats");
    const stat = (value, label, delta, anim) => {
      const s = el("div", "stat");
      const v = el("div", "v", value);
      s.append(v, el("div", "l", label));
      if (delta) s.append(el("div", "d", delta));
      stats.append(s);
      if (anim) countUp(v, anim.target, anim.fmt);
    };
    const zip = ZIP_RE.test(name);
    stat(
      latest ? fmtMoney(latest.median) : "—",
      latest ? `median assessed, ${latest.year} roll`
             : zip ? "assessed values aren't ZIP-coded" : "median assessed",
      change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs ${latest.year - 5}` : null,
      latest ? { target: latest.median, fmt: fmtMoney } : null
    );
    if (!zip) {
      stat(latest ? fmtInt(latest.count) : "—", "parcels in view", null,
        latest ? { target: latest.count, fmt: (n) => fmtInt(Math.round(n)) } : null);
    }
    stat(
      evLatest ? fmtInt(evLatest.count) : "0",
      evLatest ? `notices filed, ${evLatest.year}` : "notices filed",
      evLatest && evPrev ? `${evLatest.count - evPrev.count >= 0 ? "+" : ""}${evLatest.count - evPrev.count} vs ${evPrev.year}` : null,
      evLatest ? { target: evLatest.count, fmt: (n) => fmtInt(Math.round(n)) } : null
    );
    tile.append(stats);
    staggerIn(tile, box.children.length);
    box.append(tile);
  }
}

// --- Rent benchmark panels

function renderRent() {
  // tear down old sparklines
  for (const k of Object.keys(state.rentCharts)) {
    state.rentCharts[k].destroy();
    delete state.rentCharts[k];
  }
  const box = $("#rent-panels");
  box.textContent = "";
  const metroBox = $("#rent-metro");
  metroBox.textContent = "";
  $("#rent-note").textContent = "";
  if (!state.rent) return;

  const rent = state.rent;
  for (const s of state.selected) {
    const e = rent.hoods[s.name];
    const color = slotColor(s.slot);
    const panel = el("div", "rent-panel");
    panel.style.setProperty("--rent-color", color);
    const h = el("h3");
    const dot = el("span", "dot");
    dot.style.background = color;
    h.append(dot, el("span", null, chipLabel(s.name)));
    panel.append(h);

    staggerIn(panel, box.children.length);

    if (!e || !e.available) {
      panel.append(el("div", "none",
        e ? "Zillow's rent index doesn't cover this neighborhood's ZIP — no benchmark available."
          : "Loading…"));
      box.append(panel);
      continue;
    }

    // hero: estimated 1-bedroom
    const beds = e.bedrooms || {};
    const hero = el("div", "rent-hero");
    const heroNum = el("span", "num", beds.br1 != null ? fmtMoneyFull(beds.br1) : "—");
    hero.append(heroNum);
    hero.append(el("span", "lbl", "est. 1-bedroom / mo"));
    hero.append(el("span", "est", "est."));
    panel.append(hero);
    if (beds.br1 != null) countUp(heroNum, beds.br1, fmtMoneyFull, 850);

    // overall + YoY
    const overall = el("div", "rent-overall");
    overall.append(el("span", null,
      `Typical asking rent, all sizes${e.exact ? " (this exact ZIP)" : ""}: ${fmtMoneyFull(e.overall)}/mo`));
    if (e.yoy != null) {
      const up = e.yoy >= 0;
      overall.append(document.createTextNode(" · "));
      overall.append(el("span", up ? "yoy-up" : "yoy-down",
        `${up ? "▲" : "▼"} ${Math.abs(e.yoy).toFixed(1)}% YoY`));
    }
    panel.append(overall);

    // bedroom grid
    const grid = el("div", "rent-beds");
    for (const [key, label] of [["studio", "Studio"], ["br1", "1 BR"], ["br2", "2 BR"], ["br3", "3 BR"]]) {
      const cell = el("div", "bed" + (key === "br1" ? " hi" : ""));
      cell.append(el("div", "b-v", beds[key] != null ? fmtMoneyFull(beds[key]) : "—"));
      cell.append(el("div", "b-l", label));
      grid.append(cell);
    }
    panel.append(grid);

    // sparkline of the neighborhood rent trend
    if (e.series && e.series.length > 1) {
      const wrap = el("div", "rent-spark");
      const canvas = document.createElement("canvas");
      wrap.append(canvas);
      panel.append(wrap);
      box.append(panel);
      state.rentCharts[s.name] = new Chart(canvas, {
        type: "line",
        data: {
          labels: e.series.map((p) => p.month),
          datasets: [{
            data: e.series.map((p) => p.value),
            borderColor: color,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: cssVar("--surface-1"),
            pointHoverBorderWidth: 2,
            tension: 0.2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              ...tooltipConfig(),
              callbacks: {
                title: (i) => i[0].label.slice(0, 7),
                label: (ctx) => `${fmtMoneyFull(ctx.parsed.y)}/mo (all sizes)`,
              },
            },
          },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    } else {
      box.append(panel);
    }
  }

  // citywide measured reference (only when a valid Census key is configured)
  const acs = rent.city_acs || {};
  if (acs.br1 != null) {
    metroBox.append(el("strong", null,
      `San Francisco citywide, measured (Census ACS ${rent.census_year || ""}): `));
    metroBox.append(document.createTextNode(
      `Studio ${fmtMoneyFull(acs.studio)} · 1 BR ${fmtMoneyFull(acs.br1)} · ` +
      `2 BR ${fmtMoneyFull(acs.br2)} · 3 BR ${fmtMoneyFull(acs.br3)}. ` +
      "Gross rent paid by current tenants (lags asking rent), citywide — not per-neighborhood. "));
  }
  // metro bedroom reference + optional Census upgrade hint
  const m = rent.metro || {};
  if (m.overall != null) {
    metroBox.append(el("strong", null, "SF-metro reference (Apartment List): "));
    metroBox.append(document.createTextNode(
      `1 BR ${fmtMoneyFull(m.br1)} · 2 BR ${fmtMoneyFull(m.br2)} · overall ${fmtMoneyFull(m.overall)}. ` +
      "The metro spans the East Bay too, so it runs below the city — it's the source of the bedroom mix, not a city figure."));
  }
  if (rent.census_note === "invalid_key") {
    metroBox.append(el("span", "census-hint",
      "A CENSUS_API_KEY is set but the Census API rejected it — brand-new keys must be " +
      "activated via the link Census emails you. Once activated, measured citywide medians appear here."));
  } else if (rent.census_note === "unreachable") {
    metroBox.append(el("span", "census-hint",
      "Couldn't reach the Census API for measured medians — the estimates above are unaffected."));
  } else if (!rent.measured_available) {
    metroBox.append(el("span", "census-hint",
      "Per-bedroom figures are estimates (neighborhood rent × metro bedroom mix). " +
      "Set a free CENSUS_API_KEY (see the README) to add measured citywide medians by bedroom from Census ACS."));
  }
  $("#rent-note").textContent =
    "Zillow ZORI is a smoothed asking-rent index across all home types (houses, condos, " +
    "apartments), matched to neighborhoods by ZIP — so neighborhoods sharing a ZIP read " +
    "alike, and levels sit above pure-apartment listings. Treat these as calibration, not quotes.";
}

// --- Shared chart options

function baseLineOptions(yFmt) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: legendConfig(),
      tooltip: tooltipConfig(),
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: cssVar("--baseline") },
        ticks: { maxRotation: 0, autoSkipPadding: 18 },
      },
      y: {
        grid: { color: cssVar("--grid"), drawTicks: false },
        border: { display: false },
        ticks: { callback: yFmt, padding: 8 },
      },
    },
  };
}

function legendConfig() {
  return {
    display: state.selected.length >= 2,
    position: "top",
    align: "end",
    labels: {
      usePointStyle: true,
      pointStyle: "circle",
      boxWidth: 8,
      boxHeight: 8,
      color: cssVar("--text-secondary"),
      font: { size: 13 },
    },
  };
}

function tooltipConfig() {
  return {
    backgroundColor: cssVar("--surface-1"),
    titleColor: cssVar("--text-primary"),
    bodyColor: cssVar("--text-secondary"),
    borderColor: cssVar("--baseline"),
    borderWidth: 1,
    padding: 10,
    boxWidth: 8,
    boxHeight: 8,
    usePointStyle: true,
    cornerRadius: 8,
  };
}

function lineDataset(label, slot, values, extra = {}) {
  const color = slotColor(slot);
  return {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: cssVar("--surface-1"), // surface ring
    pointHoverBorderWidth: 2,
    spanGaps: false, // sparse years stay visible as gaps
    tension: 0.15,
    ...extra,
  };
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

// --- Assessed values chart

function renderValuesChart() {
  destroyChart("values");
  const all = seriesEntries();
  const entries = all.filter((e) => e.d.values.length); // ZIPs have no assessor rows
  const zipsSkipped = all.length - entries.length;
  if (!entries.length) return;

  const years = [...new Set(entries.flatMap((e) => e.d.values.map((v) => v.year)))].sort();
  const lookups = entries.map((e) => new Map(e.d.values.map((v) => [v.year, v])));

  const datasets = entries.map((e, i) =>
    lineDataset(e.name, e.slot, years.map((y) => lookups[i].get(y)?.median ?? null)));

  const opts = baseLineOptions((v) => fmtMoney(v));
  opts.plugins.tooltip.callbacks = {
    label(ctx) {
      const v = lookups[ctx.datasetIndex].get(years[ctx.dataIndex]);
      if (!v || v.median == null) return `${ctx.dataset.label}: too few parcels`;
      return `${ctx.dataset.label}: ${fmtMoneyFull(v.median)} median · ${fmtInt(v.count)} parcels`;
    },
    afterBody(items) {
      const v = lookups[items[0]?.datasetIndex]?.get(years[items[0]?.dataIndex]);
      return v?.mean != null ? [`(mean ${fmtMoneyFull(v.mean)})`] : [];
    },
  };
  opts.animations = progressiveDraw(years.length);
  state.charts.values = new Chart($("#chart-values"), {
    type: "line",
    data: { labels: years, datasets },
    options: opts,
  });

  $("#note-values").textContent =
    "Gaps mean too few parcels that year for a reliable median. " +
    useFilterNote() +
    (zipsSkipped ? " ZIP selections don't appear here — the assessor roll isn't ZIP-coded." : "");
  buildTable("values", years, entries, (e, y) => {
    const v = new Map(e.d.values.map((x) => [x.year, x])).get(y);
    return v?.median != null ? `${fmtMoneyFull(v.median)} (${fmtInt(v.count)})` : null;
  }, "Roll year", "median assessed value (parcel count)");
}

function useFilterNote() {
  return {
    res: "Showing residential parcels (single-family + multi-family).",
    sfr: "Showing single-family residential parcels only.",
    mfr: "Showing multi-family residential parcels only.",
    all: "Showing all secured parcels, including commercial and industrial.",
  }[state.use];
}

// --- Evictions chart

function renderEvictionsChart() {
  destroyChart("evictions");
  const entries = seriesEntries();
  if (!entries.length) return;

  const allYears = entries.flatMap((e) => e.d.evictions.map((v) => v.year));
  if (!allYears.length) return;
  const minY = Math.min(...allYears);
  const maxY = Math.max(...allYears);
  const years = [];
  for (let y = minY; y <= maxY; y++) years.push(y);
  const lookups = entries.map((e) => new Map(e.d.evictions.map((v) => [v.year, v])));
  const nowYear = new Date().getFullYear();

  const datasets = entries.map((e, i) =>
    lineDataset(
      chipLabel(e.name),
      e.slot,
      years.map((y) => lookups[i].get(y)?.count ?? 0), // no notices = 0, honestly
      {
        segment: { // dash the in-progress year
          borderDash: (ctx) =>
            years[ctx.p1DataIndex] === nowYear ? [5, 4] : undefined,
        },
      }
    ));

  const opts = baseLineOptions((v) => fmtInt(v));
  opts.scales.y.beginAtZero = true;
  opts.plugins.tooltip.callbacks = {
    title: (items) => {
      const y = years[items[0]?.dataIndex];
      return y === nowYear ? `${y} (partial year)` : String(y);
    },
    label: (ctx) => `${ctx.dataset.label}: ${fmtInt(ctx.parsed.y)} notices`,
  };
  opts.animations = progressiveDraw(years.length, 1100);
  state.charts.evictions = new Chart($("#chart-evictions"), {
    type: "line",
    data: { labels: years, datasets },
    options: opts,
  });

  $("#note-evictions").textContent =
    `Dashed final segment: ${nowYear} is in progress. Counts are notices filed, ` +
    "not households displaced — the citywide Ellis Act and owner-move-in waves of " +
    "the late '90s and mid-2010s are visible in most neighborhoods.";
  buildTable("evictions", years, entries, (e, y) => {
    const v = new Map(e.d.evictions.map((x) => [x.year, x])).get(y);
    return fmtInt(v?.count ?? 0) + (v?.partial ? " (partial)" : "");
  }, "Year", "eviction notices filed");
}

// --- Reasons chart

function renderReasonsChart() {
  destroyChart("reasons");
  const entries = seriesEntries();
  if (!entries.length) return;

  // Top 10 reasons by combined count across the selection, fixed order.
  const totals = new Map();
  const perHood = entries.map((e) => new Map(e.d.reasons.map((r) => [r.key, r.count])));
  const labels = new Map();
  for (const e of entries) {
    for (const r of e.d.reasons) {
      totals.set(r.key, (totals.get(r.key) || 0) + r.count);
      labels.set(r.key, r.label);
    }
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
  if (!top.length) return;

  const datasets = entries.map((e, i) => ({
    label: chipLabel(e.name),
    data: top.map((k) => perHood[i].get(k) || 0),
    backgroundColor: slotColor(e.slot),
    maxBarThickness: 16,
    borderRadius: 4,          // rounded data-end…
    borderSkipped: "start",   // …square at the baseline
    categoryPercentage: 0.78,
    barPercentage: 0.9,
  }));

  state.charts.reasons = new Chart($("#chart-reasons"), {
    type: "bar",
    data: { labels: top.map((k) => labels.get(k)), datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: legendConfig(),
        tooltip: {
          ...tooltipConfig(),
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtInt(ctx.parsed.x)} notices (all years)`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: cssVar("--grid"), drawTicks: false },
          border: { display: false },
          ticks: { callback: (v) => fmtInt(v) },
        },
        y: {
          grid: { display: false },
          border: { color: cssVar("--baseline") },
          ticks: { color: cssVar("--text-secondary"), autoSkip: false },
        },
      },
    },
  });

  buildTable("reasons", top.map((k) => labels.get(k)), entries, (e, label) => {
    const key = top.find((k) => labels.get(k) === label);
    return fmtInt(new Map(e.d.reasons.map((r) => [r.key, r.count])).get(key) || 0);
  }, "Stated reason", "notices citing it (all years)");
}

// --- Table views (the accessibility fallback for every chart)

function buildTable(key, rows, entries, cellFn, rowHeader, caption) {
  const box = document.getElementById(`table-${key}`);
  box.textContent = "";
  const table = document.createElement("table");
  const thead = table.createTHead().insertRow();
  thead.append(el("th", null, rowHeader));
  for (const e of entries) thead.append(el("th", null, chipLabel(e.name)));
  const tbody = table.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    tr.append(el("td", null, String(r)));
    for (const e of entries) {
      const v = cellFn(e, r);
      tr.append(el("td", v == null ? "na" : null, v == null ? "—" : v));
    }
  }
  const cap = table.createCaption();
  cap.className = "chart-note";
  cap.textContent = `${rowHeader} × ${caption}`;
  box.append(table);
}

function toggleTable(key, btn) {
  const tableBox = document.getElementById(`table-${key}`);
  const plot = tableBox.previousElementSibling;
  const showTable = tableBox.hidden;
  tableBox.hidden = !showTable;
  plot.style.display = showTable ? "none" : "";
  btn.textContent = showTable ? "Chart" : "Table";
}

// ---------------------------------------------------------------------------
// Address / parcel lookup

async function runLookup() {
  const q = $("#lookup-input").value.trim();
  if (!q) return;
  const status = $("#lookup-status");
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "Searching DataSF…";
  $("#lookup-results").textContent = "";
  $("#parcel-detail").hidden = true;
  try {
    const res = await fetch(`/api/lookup?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    status.hidden = true;
    renderLookupResults(body);
  } catch (e) {
    status.classList.add("error");
    status.textContent = `Search failed: ${e.message}`;
  }
}

function renderLookupResults({ parcels, truncated }) {
  const box = $("#lookup-results");
  box.textContent = "";
  if (!parcels.length) {
    box.append(el("p", "chart-note",
      "No parcels matched. Try just the street number and name (no “St”/“Ave”), or a 7-character parcel number."));
    return;
  }
  for (const p of parcels) {
    const btn = el("button", "parcel-row");
    const left = el("div");
    left.append(el("div", "loc", p.location || `Parcel ${p.parcel_number}`));
    const bits = [
      `Parcel ${p.parcel_number}`,
      p.neighborhood,
      p.use,
      p.units ? `${p.units} unit${p.units > 1 ? "s" : ""}` : null,
      p.built ? `built ${p.built}` : null,
    ].filter(Boolean);
    left.append(el("div", "sub", bits.join(" · ")));
    const last = p.history[p.history.length - 1];
    const right = el("div", "val", last ? `${fmtMoney(last.value)} (${last.year})` : "—");
    btn.append(left, right);
    btn.onclick = () => {
      box.querySelectorAll(".parcel-row").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      showParcelDetail(p);
    };
    box.append(btn);
  }
  if (truncated) {
    box.append(el("p", "chart-note", "Showing the first 20 matching parcels — narrow the search for more specific results."));
  }
}

function showParcelDetail(p) {
  $("#parcel-detail").hidden = false;
  $("#parcel-title").textContent = p.location || `Parcel ${p.parcel_number}`;
  $("#parcel-sub").textContent = [
    `Parcel ${p.parcel_number}`, p.neighborhood, p.use,
    p.units ? `${p.units} unit${p.units > 1 ? "s" : ""}` : null,
    p.built ? `built ${p.built}` : null,
  ].filter(Boolean).join(" · ");

  destroyChart("parcel");
  const years = p.history.map((h) => h.year);
  const opts = baseLineOptions((v) => fmtMoney(v));
  opts.plugins.legend.display = false; // single series — the title names it
  opts.plugins.tooltip.callbacks = {
    label: (ctx) => `Assessed: ${fmtMoneyFull(ctx.parsed.y)}`,
  };
  opts.animations = progressiveDraw(years.length, 700);
  state.charts.parcel = new Chart($("#chart-parcel"), {
    type: "line",
    data: {
      labels: years,
      datasets: [lineDataset("Assessed value", 0, p.history.map((h) => h.value), {
        pointRadius: 3,
        pointBackgroundColor: slotColor(0),
        pointBorderColor: cssVar("--surface-1"),
        pointBorderWidth: 2,
      })],
    },
    options: opts,
  });
  $("#parcel-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------------------
// Wiring

function wire() {
  $("#hood-add").onclick = () => addHood($("#hood-input").value.trim());
  $("#hood-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHood($("#hood-input").value.trim());
  });
  // datalist click-selection fires "change"
  $("#hood-input").addEventListener("change", () => {
    const v = normalizeHoodName($("#hood-input").value);
    if (hoodInfo(v)) addHood(v);
  });

  document.querySelectorAll(".quick-hood").forEach((button) => {
    button.onclick = () => {
      const name = button.dataset.hood;
      if (state.selected.some((selected) => selected.name === name)) {
        removeHood(name);
      } else {
        addHood(name);
      }
    };
  });

  document.querySelectorAll(".seg").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".seg").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.use = b.dataset.use;
      updateTrends();
    };
  });

  document.querySelectorAll(".table-toggle").forEach((b) => {
    b.onclick = () => toggleTable(b.dataset.chart, b);
  });

  $("#rent-refresh").onclick = refreshRent;

  $("#lookup-btn").onclick = runLookup;
  $("#lookup-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runLookup();
  });

  // Dark mode has its own palette steps — rebuild charts when the scheme flips.
  // (Guard against spurious 'change' events that report the same scheme.)
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  let wasDark = darkMq.matches;
  darkMq.addEventListener("change", (ev) => {
    if (ev.matches === wasDark) return;
    wasDark = ev.matches;
    applyChartDefaults();
    renderAll();
    renderChips();
  });
}

async function init() {
  applyChartDefaults();
  wire();
  renderAll(); // hides empty sections
  loadMap();   // heat map is the pre-search view; loads independently
  try {
    await loadHoodList();
    showStatus("Pick up to three neighborhoods. The first look downloads their public records; after that they load from the local cache.");
  } catch (e) {
    showStatus(`Couldn't reach the server or DataSF: ${e.message}`, { error: true });
  }
}

init();
