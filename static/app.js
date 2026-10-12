/* Ground Truth — frontend. Reads the precomputed JSON in /data.
   Charts: 2px lines, hover markers with a surface ring, hairline grids, a
   legend only for two or more series, and a table view for every chart.
   A neighborhood keeps its color slot for as long as it stays selected. */

"use strict";

// ---------------------------------------------------------------------------
// State

const MAX_HOODS = 3;
const state = {
  allHoods: [],            // [{name, assessor_rows, eviction_rows}]
  selected: [],            // [{name, slot}]; slot is 0..2 and sticky per hood
  use: "res",
  data: null,              // {hood: trends/<slug>-<use>.json}
  rent: null,              // rent.json
  rentRequest: null,       // in-flight or settled rent.json promise
  map: null,               // rentmap.json
  mapShapes: [],           // [{path, hoods}] for selection outlines
  charts: {},              // Chart instances by key
  rentCharts: {},          // sparkline Chart instances by hood
  requestToken: 0,
};

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const PICK_PROMPT = "Pick up to three neighborhoods. Their public data is already packed in, so comparisons load right away.";
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

const isFeatured = (name) => FEATURED_HOODS.some((hood) => hood.name === name);

function displayHoodName(name) {
  return FEATURED_HOODS.find((hood) => hood.name === name)?.label || name;
}

function hoodSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const $ = (sel) => document.querySelector(sel);

// Fetch precomputed JSON. Check the status before parsing, so a missing file
// (often served as an HTML page) reads as "HTTP 404" rather than a JSON error.
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} didn't return JSON`);
  }
}
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
  Chart.defaults.animation = REDUCED_MOTION ? false : { duration: 250 };
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

// ---------------------------------------------------------------------------
// Status line under the picker: the prompt, loading, and errors

function showStatus(msg, { error = false } = {}) {
  const box = $("#status");
  box.hidden = false;
  box.classList.toggle("error", error);
  box.textContent = msg;
}
function hideStatus() {
  $("#status").hidden = true;
  $("#status").classList.remove("error");
}

// ---------------------------------------------------------------------------
// Neighborhood picker

async function loadHoodList() {
  state.allHoods = (await getJSON("/data/neighborhoods.json")).neighborhoods
    .filter((h) => isFeatured(h.name));
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
  if (!name) return;
  if (!isFeatured(name)) {
    showStatus(`"${name}" isn't one of the six neighborhoods. Pick one above.`, { error: true });
    return;
  }
  if (state.selected.some((s) => s.name === name)) return;
  if (state.selected.length >= MAX_HOODS) {
    showStatus(`You can compare up to ${MAX_HOODS} neighborhoods. Remove one first.`, { error: true });
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

function renderChips() {
  const box = $("#hood-chips");
  box.textContent = "";
  for (const s of state.selected) {
    const label = displayHoodName(s.name);
    const chip = el("span", "chip");
    const dot = el("span", "dot");
    dot.style.background = slotColor(s.slot);
    chip.append(dot, el("span", null, label));
    const info = hoodInfo(s.name);
    if (info) chip.append(el("span", "meta", `${fmtInt(info.assessor_rows)} records`));
    const close = el("button", null, "×");
    close.type = "button";
    close.setAttribute("aria-label", `Remove ${label}`);
    close.onclick = () => removeHood(s.name);
    chip.append(close);
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
    state.map = await getJSON("/data/rentmap.json");
    status.hidden = true;
    renderMap();
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
  svg.setAttribute("aria-label", "Map of San Francisco ZIP codes shaded by typical asking rent");
  const tip = $("#map-tip");
  state.mapShapes = [];

  const labelLayer = document.createElementNS(svg.namespaceURI, "g");
  const placed = []; // label anchors already drawn, to avoid overlaps downtown
  for (const f of feats) {
    const rings = ringsOf(f.geometry).map((ring) => ring.map((p) => [px(p[0]), py(p[1])]));
    const d = rings.map((ring) =>
      ring.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("") + "Z"
    ).join("");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill-rule", "evenodd");
    path.classList.add("zip-shape");
    const has = f.value != null;
    const fill = has ? rampColor(f.value) : null;
    if (has) {
      path.setAttribute("fill", fill);
    } else {
      path.setAttribute("fill", "var(--wash)");
      path.classList.add("nodata");
    }
    path.addEventListener("mousemove", (ev) => {
      tip.hidden = false;
      tip.textContent = "";
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
    state.mapShapes.push({ path, hoods: f.hoods });

    // Label shapes big enough to hold text. The anchor is the centroid of the
    // largest ring, and only if it falls inside the shape: a bounding-box
    // center can land on a neighboring ZIP (94105 sat on 94111). Anything
    // that doesn't fit falls back to the tooltip.
    const anchor = labelAnchor(rings);
    if (!has || !anchor) continue;
    const [cx, cy] = anchor.point;
    const clear = placed.every(([x, y]) => Math.abs(x - cx) > 44 || Math.abs(y - cy) > 36);
    if (!clear || anchor.width <= 74 || anchor.height <= 42) continue;
    placed.push([cx, cy]);
    const ink = labelInk(fill);
    const zipText = svgText(svg, cx, cy - 2, 12, ink, f.zip);
    // One decimal: the citywide range is only ~$3K to $6.5K.
    const valText = svgText(svg, cx, cy + 12, 11, ink, `$${(f.value / 1000).toFixed(1)}K`);
    valText.classList.add("val");
    labelLayer.append(zipText, valText);
  }
  svg.append(labelLayer);
  box.append(svg);

  const legend = $("#map-legend");
  legend.hidden = false;
  $("#legend-min").textContent = fmtMoneyFull(vMin) + "/mo";
  $("#legend-max").textContent = fmtMoneyFull(vMax) + "/mo";
  updateMapSelection();
}

function svgText(svg, x, y, size, fill, text) {
  const node = document.createElementNS(svg.namespaceURI, "text");
  node.classList.add("zip-label");
  node.setAttribute("x", x);
  node.setAttribute("y", y);
  node.setAttribute("text-anchor", "middle");
  node.setAttribute("font-size", size);
  node.setAttribute("fill", fill);
  node.textContent = text;
  return node;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function insideRings(rings, x, y) {
  let inside = false; // even-odd across every ring, matching fill-rule
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function labelAnchor(rings) {
  const ring = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
  const area = ringArea(ring);
  if (!area) return null;
  let cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  cx /= 6 * area;
  cy /= 6 * area;
  if (!insideRings(rings, cx, cy)) return null;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return {
    point: [cx, cy],
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

// Pick whichever ink (white or the ramp's darkest step) contrasts more with
// the fill it sits on.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function labelInk(fill) {
  const dark = SEQ_RAMP[SEQ_RAMP.length - 1];
  const bg = luminance(fill);
  const onWhite = 1.05 / (bg + 0.05);
  const onDark = (bg + 0.05) / (luminance(dark) + 0.05);
  return onWhite >= onDark ? "#ffffff" : dark;
}

// Outline every ZIP the selected neighborhoods are matched to.
function updateMapSelection() {
  const chosen = new Set(state.selected.map((s) => s.name));
  for (const { path, hoods } of state.mapShapes) {
    const selected = hoods.some((h) => chosen.has(h));
    path.classList.toggle("selected", selected);
    // Draw outlined shapes last so neighbors don't paint over the stroke.
    if (selected) path.parentNode.insertBefore(path, path.parentNode.lastChild);
  }
}

// ---------------------------------------------------------------------------
// Data loading

async function updateTrends() {
  const token = ++state.requestToken;
  const names = state.selected.map((s) => s.name);
  if (!names.length) {
    state.data = null;
    showStatus(PICK_PROMPT);
    renderAll();
    return;
  }
  loadRent();
  showStatus("Loading…");
  try {
    const rows = await Promise.all(names.map(async (name) =>
      [name, await getJSON(`/data/trends/${hoodSlug(name)}-${state.use}.json`)]));
    if (token !== state.requestToken) return; // superseded by a newer request
    state.data = Object.fromEntries(rows);
    hideStatus();
  } catch (e) {
    if (token !== state.requestToken) return;
    // Drop the old charts rather than leave them labeled with the new selection.
    state.data = null;
    showStatus(`Couldn't load property and eviction data: ${e.message}`, { error: true });
  }
  renderAll();
}

// rent.json covers all six neighborhoods, so it's fetched once and reused.
// A failed fetch is retried on the next selection change.
async function loadRent() {
  const status = $("#rent-status");
  if (!state.rentRequest) {
    status.hidden = false;
    status.classList.remove("error");
    status.textContent = "Loading the rent benchmark…";
    state.rentRequest = getJSON("/data/rent.json");
  }
  try {
    state.rent = await state.rentRequest;
    status.hidden = true;
    renderRent();
  } catch (e) {
    state.rentRequest = null;
    status.classList.add("error");
    status.textContent = `Couldn't load the rent benchmark: ${e.message}`;
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
  const picked = state.selected.length > 0;
  const has = picked && !!state.data;
  // Rent comes from its own file, so it stays up when the trends files fail.
  $("#card-rent").style.display = picked ? "" : "none";
  for (const id of ["tiles", "card-values", "card-evictions", "card-reasons"]) {
    document.getElementById(id).style.display = has ? "" : "none";
  }
  // Hide a chart card outright when no selected hood has rows for it.
  const entries = seriesEntries();
  for (const [id, key] of [["card-values", "values"], ["card-evictions", "evictions"],
                           ["card-reasons", "reasons"]]) {
    if (has && !entries.some((e) => e.d[key].length)) $(`#${id}`).style.display = "none";
  }
}

// Selected hoods in selection order, skipping any whose data isn't loaded.
function seriesEntries() {
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
    h.append(dot, el("span", null, displayHoodName(name)));
    tile.append(h);

    const stats = el("div", "stats");
    const stat = (value, label, delta) => {
      const s = el("div", "stat");
      s.append(el("div", "v", value), el("div", "l", label));
      if (delta) s.append(el("div", "d", delta));
      stats.append(s);
    };
    stat(
      latest ? fmtMoney(latest.median) : "—",
      latest ? `median assessed, ${latest.year} roll` : "median assessed",
      change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs ${latest.year - 5}` : null
    );
    stat(latest ? fmtInt(latest.count) : "—", "parcels in view");
    stat(
      evLatest ? fmtInt(evLatest.count) : "0",
      evLatest ? `notices filed, ${evLatest.year}` : "notices filed",
      evLatest && evPrev ? `${evLatest.count - evPrev.count >= 0 ? "+" : ""}${evLatest.count - evPrev.count} vs ${evPrev.year}` : null
    );
    tile.append(stats);
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
    h.append(dot, el("span", null, displayHoodName(s.name)));
    panel.append(h);

    if (!e || !e.available) {
      panel.append(el("div", "none",
        "Zillow's rent index doesn't cover this neighborhood's ZIPs, so there's no benchmark."));
      box.append(panel);
      continue;
    }

    // hero: estimated 1-bedroom
    const beds = e.bedrooms || {};
    const hero = el("div", "rent-hero");
    hero.append(el("span", "num", beds.br1 != null ? fmtMoneyFull(beds.br1) : "—"));
    hero.append(el("span", "lbl", "1-bedroom / mo"));
    hero.append(el("span", "est", "est."));
    panel.append(hero);

    // overall + YoY
    const overall = el("div", "rent-overall");
    overall.append(el("span", null,
      `Typical asking rent, all sizes: ${fmtMoneyFull(e.overall)}/mo`));
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
      const month = (p) => new Date(p.month + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
      panel.append(el("div", "spark-range",
        `${month(e.series[0])} – ${month(e.series[e.series.length - 1])}`));
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
      "Per-bedroom figures are estimates (neighborhood rent × metro bedroom mix), " +
      "not measured medians."));
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
  const entries = seriesEntries().filter((e) => e.d.values.length);
  if (!entries.length) return;

  const years = [...new Set(entries.flatMap((e) => e.d.values.map((v) => v.year)))]
    .sort((a, b) => a - b);
  const lookups = entries.map((e) => new Map(e.d.values.map((v) => [v.year, v])));

  const datasets = entries.map((e, i) =>
    lineDataset(displayHoodName(e.name), e.slot, years.map((y) => lookups[i].get(y)?.median ?? null)));

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
  state.charts.values = new Chart($("#chart-values"), {
    type: "line",
    data: { labels: years, datasets },
    options: opts,
  });

  $("#note-values").textContent =
    "Gaps mean too few parcels that year for a reliable median. " + useFilterNote();
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
  // the export marks the in-progress year; the browser's clock may be later
  const partialYear = entries.flatMap((e) => e.d.evictions)
    .find((v) => v.partial)?.year ?? null;

  const datasets = entries.map((e, i) =>
    lineDataset(
      displayHoodName(e.name),
      e.slot,
      years.map((y) => lookups[i].get(y)?.count ?? 0), // no notices = 0, honestly
      {
        segment: { // dash the in-progress year
          borderDash: (ctx) =>
            years[ctx.p1DataIndex] === partialYear ? [5, 4] : undefined,
        },
      }
    ));

  const opts = baseLineOptions((v) => fmtInt(v));
  opts.scales.y.beginAtZero = true;
  opts.plugins.tooltip.callbacks = {
    title: (items) => {
      const y = years[items[0]?.dataIndex];
      return y === partialYear ? `${y} (partial year)` : String(y);
    },
    label: (ctx) => `${ctx.dataset.label}: ${fmtInt(ctx.parsed.y)} notices`,
  };
  state.charts.evictions = new Chart($("#chart-evictions"), {
    type: "line",
    data: { labels: years, datasets },
    options: opts,
  });

  $("#note-evictions").textContent =
    (partialYear ? `Dashed final segment: ${partialYear} was in progress when the data was exported. ` : "") +
    "Counts are notices filed, " +
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
    label: displayHoodName(e.name),
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
  for (const e of entries) thead.append(el("th", null, displayHoodName(e.name)));
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
  btn.setAttribute("aria-pressed", showTable ? "true" : "false");
}

// ---------------------------------------------------------------------------
// Wiring

function wire() {
  $("#hood-add").onclick = () => addHood($("#hood-input").value.trim());
  $("#hood-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHood($("#hood-input").value.trim());
  });
  // Picking from the datalist fires "change" without a keypress.
  $("#hood-input").addEventListener("change", () => {
    const v = normalizeHoodName($("#hood-input").value);
    if (isFeatured(v)) addHood(v);
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
      document.querySelectorAll(".seg").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
      state.use = b.dataset.use;
      updateTrends();
    };
  });

  document.querySelectorAll(".table-toggle").forEach((b) => {
    b.onclick = () => toggleTable(b.dataset.chart, b);
  });

  // Dark mode has its own palette steps, so rebuild charts when the scheme
  // flips. Some browsers fire "change" without the scheme actually changing.
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
  renderAll(); // hides the empty sections
  loadMap();
  try {
    await loadHoodList();
    renderChips(); // fills in record counts for anything picked during the load
    if (!state.selected.length) showStatus(PICK_PROMPT);
  } catch (e) {
    showStatus(`Couldn't load the neighborhood list: ${e.message}`, { error: true });
  }
}

init();
