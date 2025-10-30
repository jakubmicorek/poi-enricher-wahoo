// js/main.js
import { $, $$, debounce } from "./util.js";
import {
  initMap,
  getMap,
  renderTrackAndWaypoints,
  getRouteLine,
  drawSearchBox,
  drawCorridor,
  addCustomPoi,
  renderAllPoisGhosted,
  renderSelectedPois,
  listCustomPois
} from "./mapview.js";
import {
  FETCH_BBOX_RADIUS_M,
  buildOverpassQueryFromConfig,
  overpassFetch
} from "./overpass.js";
import { addPoisAsWaypointsToGpx, stripWaypointsFromGpx } from "./gpx.js";

/* ---------- Config state ---------- */
let WAHOO = { version: 1, categories: [] };
let OVERPASS = { version: 1, items: [] };
const WAHOO_ITEM_BY_ID = new Map();
const CATEGORY_ORDER = [];
const CATEGORY_META = new Map();

/* ---------- App state ---------- */
let originalGpxXmlString = "";
let originalFilename = "route.gpx";

// add-poi modal state
let pendingPoiTypeId = null;
let pendingPoiName = "";
let pendingPoiDesc = "";

/* ---------- POI render state ---------- */
let ALL_FETCHED_POIS = [];
let LAST_INSIDE_SELECTED = [];
let CORRIDOR_POLY = null;
let SHOW_DISTANCE_LINES = true;

/* ---------- Responsive ---------- */
function isMobile() {
  try {
    return (window.matchMedia && matchMedia("(max-width: 820px)").matches) || window.innerWidth <= 820;
  } catch {
    return window.innerWidth <= 820;
  }
}
function applyInitialPanelState() {
  const mob = isMobile();
  document.body.classList.toggle("mob", mob);
  const lp = $("#left-panel"), rp = $("#right-panel");
  if (mob) { lp?.classList.remove("open"); rp?.classList.remove("open"); }
  else { lp?.classList.add("open"); rp?.classList.add("open"); }
  setTimeout(() => getMap()?.invalidateSize(), 0);
}

/* ---------- Errors ---------- */
window.addEventListener("error", (e) =>
  showBootError(e.error?.stack || e.message || String(e))
);
window.addEventListener("unhandledrejection", (e) =>
  showBootError(e.reason?.stack || e.reason?.message || String(e))
);

/* ---------- Startup ---------- */
window.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!window.L) throw new Error("Leaflet not loaded");
    if (!window.toGeoJSON) throw new Error("toGeoJSON not loaded");
    if (!window.turf) throw new Error("Turf not loaded");

    initMap();
    hookMapClicksForPlacement();

    await loadConfigsSafe();
    indexConfigs();

    // expose lookup so mapview can render waypoint icons for imported GPX
    // expose lookup so mapview can render waypoint icons for imported GPX
    window.getWahooIconUrl = (id) => {
      const key = String(id || "").trim().toLowerCase();
      const known = WAHOO_ITEM_BY_ID.get(key)?.icon || null;
      // If not in wahoo.json (or empty sym/type), use a generic round fallback.
      return known || "icons/undefined.svg";
    };


    buildPoiPanel();
    buildAddPoiModalOptions();
    hookUi();

    applyInitialPanelState();
    addEventListener("resize", applyInitialPanelState);

    await autoLoadSample();

    drawSearchBoxAndCorridor();
    setPoiStatus("Choose POIs and fetch.");
    updateExportUi();
  } catch (err) {
    showBootError(err?.stack || err?.message || String(err));
  }
});

/* ---------- Config load/index ---------- */
async function loadConfigsSafe() {
  try {
    const res = await fetch("./config/wahoo.json", { cache: "no-store" });
    if (res.ok) WAHOO = await res.json();
  } catch {}
  try {
    const res = await fetch("./config/overpass.json", { cache: "no-store" });
    if (res.ok) OVERPASS = await res.json();
  } catch {}
}
function indexConfigs() {
  WAHOO_ITEM_BY_ID.clear();
  CATEGORY_ORDER.length = 0;
  CATEGORY_META.clear();
  (WAHOO?.categories || []).forEach(cat => {
    CATEGORY_ORDER.push(cat.id);
    CATEGORY_META.set(cat.id, {
      label: cat.label,
      color: cat.color || "gray",
      defaultExpanded: !!cat.defaultExpanded
    });
    (cat.items || []).forEach(it => {
      WAHOO_ITEM_BY_ID.set(it.id, {
        ...it,
        categoryId: cat.id,
        categoryLabel: cat.label,
        color: cat.color || "gray"
      });
    });
  });
}

/* ---------- Build POI panel ---------- */
function buildPoiPanel() {
  const wrap = $("#poi-groups");
  if (!wrap) return;
  wrap.innerHTML = "";

  const byCat = new Map();
  (OVERPASS?.items || []).forEach(op => {
    const w = WAHOO_ITEM_BY_ID.get(op.wahoo_id);
    if (!w) return;
    if (!byCat.has(w.categoryId)) byCat.set(w.categoryId, []);
    byCat.get(w.categoryId).push({ op, w });
  });

  CATEGORY_ORDER.forEach(catId => {
    const rows = byCat.get(catId);
    if (!rows?.length) return;

    rows.sort((a,b) => a.op.label.localeCompare(b.op.label));
    const { label: catLabel, color } = CATEGORY_META.get(catId) || { label: catId, color: "gray" };

    const catEl = document.createElement("div");
    const isOpen = !!(CATEGORY_META.get(catId)?.defaultExpanded);
    catEl.className = `poi-cat${isOpen ? " open" : ""}`;

    const head = document.createElement("div");
    head.className = "poi-cat-head";
    head.innerHTML = `
      <span class="pill ${color}" aria-hidden="true"></span>
      <span class="poi-cat-title">${catLabel}</span>
      <span class="poi-cat-actions">
        <button type="button" class="btn-mini act-all">Select all</button>
        <button type="button" class="btn-mini act-none">Unselect all</button>
      </span>
    `;
    catEl.appendChild(head);

    const body = document.createElement("div");
    body.className = "poi-cat-body";

    rows.forEach(({op, w}) => {
      const row = document.createElement("label");
      row.className = "poi-row";
      const checked = op.defaultSelected ? "checked" : "";
      const icon = w.icon || "";
      row.innerHTML = `
        <input type="checkbox" data-op="${op.id}" data-wahoo="${w.id}" ${checked}/>
        <img src="${icon}" alt="${w.id}" onerror="this.style.display='none'"/>
        <span>${op.label}</span>
        <span class="map-chip">${w.id}</span>
      `;
      body.appendChild(row);
    });

    catEl.appendChild(body);
    wrap.appendChild(catEl);

    head.addEventListener("click", (ev) => {
      const inActions = (ev.target.closest(".poi-cat-actions") !== null);
      if (inActions) return;
      catEl.classList.toggle("open");
    });
    head.querySelector(".act-all")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      body.querySelectorAll('input[type="checkbox"][data-op]').forEach(cb => { cb.checked = true; });
      onPoiSelectionChanged();
    });
    head.querySelector(".act-none")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      body.querySelectorAll('input[type="checkbox"][data-op]').forEach(cb => { cb.checked = false; });
      onPoiSelectionChanged();
    });
  });

  wrap.addEventListener("change", onPoiSelectionChanged);
  renderSelectedChips();
  updatePoiLayers();
}

function onPoiSelectionChanged() {
  renderSelectedChips();
  updatePoiLayers();
  updateExportUi();
}

/* ---------- Selected chips ---------- */
function renderSelectedChips() {
  const chipsEl = $("#selected-chips");
  if (!chipsEl) return;
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const sel = cbs.filter(cb => cb.checked).map(cb => cb.getAttribute("data-op"));

  chipsEl.innerHTML = "";
  sel.forEach(opId => {
    const op = (OVERPASS?.items || []).find(x => x.id === opId);
    if (!op) return;
    const w = WAHOO_ITEM_BY_ID.get(op.wahoo_id);
    if (!w) return;
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.title = "Click to unselect";
    chip.innerHTML = `<img src="${w.icon||""}" alt="${w.id}" onerror="this.style.display='none'"/><span>${op.label}</span>`;
    chip.addEventListener("click", () => {
      const cb = $(`#poi-groups input[data-op="${op.id}"]`);
      if (cb) {
        cb.checked = false;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    chipsEl.appendChild(chip);
  });
}

/* ---------- Add-POI modal ---------- */
function buildAddPoiModalOptions() {
  const list = $("#add-poi-types");
  if (!list) return;
  list.innerHTML = "";

  (WAHOO?.categories || []).forEach(cat => {
    const box = document.createElement("div");
    box.className = "type-cat";

    const head = document.createElement("div");
    head.className = "type-cat-head";
    head.textContent = cat.label;
    box.appendChild(head);

    const items = document.createElement("div");
    items.className = "type-items";

    (cat.items || [])
      .slice()
      .sort((a,b) => a.label.localeCompare(b.label))
      .forEach(it => {
        const row = document.createElement("label");
        row.className = "type-row";
        row.innerHTML = `
          <input type="radio" name="poi-type" value="${it.id}">
          <img src="${it.icon||""}" alt="${it.id}" onerror="this.style.display='none'"/>
          <span>${it.label}</span>
        `;
        items.appendChild(row);
      });

    box.appendChild(items);
    list.appendChild(box);
  });

  const first = list.querySelector('input[type="radio"][name="poi-type"]');
  if (first) first.checked = true;
}

/* ---------- Map click to place the pending POI ---------- */
function hookMapClicksForPlacement() {
  const map = getMap();
  if (!map) return;
  map.on("click", (e) => {
    if (!document.body.classList.contains("add-poi-armed")) return;
    if (!pendingPoiTypeId) return;

    const { lat, lng } = e.latlng;
    const typeMeta = WAHOO_ITEM_BY_ID.get(pendingPoiTypeId);
    const iconUrl = typeMeta?.icon || null;
    const name = pendingPoiName || typeMeta?.label || pendingPoiTypeId;
    const desc = pendingPoiDesc || "";

    addCustomPoi(lat, lng, pendingPoiTypeId, name, desc, iconUrl);

    // reflect in export button immediately
    updateExportUi();

    document.body.classList.remove("add-poi-armed");
    pendingPoiTypeId = null;
    pendingPoiName = "";
    pendingPoiDesc = "";
  });
}

/* ---------- UI hooks ---------- */
function hookUi() {
  $("#file")?.addEventListener("change", onFile);
  addEventListener("dragover", e => e.preventDefault());
  addEventListener("drop", onDrop);

  // Corridor width change: redraw, recompute inside flags, then update layers/export
  const onCorridor = debounce(() => {
    drawSearchBoxAndCorridor();
    recomputeInsideFlagsForAllFetched();
    updatePoiLayers();
    updateExportUi();
  }, 120);
  $("#poi-range-m")?.addEventListener("input", onCorridor);
  $("#poi-range-m")?.addEventListener("change", onCorridor);

  $("#toggle-lines")?.addEventListener("change", () => {
    SHOW_DISTANCE_LINES = !!$("#toggle-lines")?.checked;
    updatePoiLayers();
  });

  $("#btn-toggle-left")?.addEventListener("click", () => {
    const el = $("#left-panel");
    const on = !el.classList.contains("open");
    el.classList.toggle("open", on);
    $("#btn-toggle-left").setAttribute("aria-pressed", on ? "true" : "false");
    setTimeout(() => getMap()?.invalidateSize(), 0);
  });
  $("#btn-toggle-right")?.addEventListener("click", () => {
    const el = $("#right-panel");
    const on = !el.classList.contains("open");
    el.classList.toggle("open", on);
    $("#btn-toggle-right").setAttribute("aria-pressed", on ? "true" : "false");
    setTimeout(() => getMap()?.invalidateSize(), 0);
  });

  // Fetch buttons
  $("#btn-fetch-selected")?.addEventListener("click", onFetchSelected);
  $("#btn-fetch-all")?.addEventListener("click", onFetchAll);

  // Export button guard
  $("#btn-download-gpx")?.addEventListener("click", (e) => {
    if ($("#btn-download-gpx")?.classList.contains("disabled")) e.preventDefault();
  });

  $("#btn-add-poi")?.addEventListener("click", () => openAddPoiModal());
  $("#add-poi-close")?.addEventListener("click", closeAddPoiModal);
  $("#add-poi-cancel")?.addEventListener("click", closeAddPoiModal);
  $("#add-poi-place")?.addEventListener("click", () => {
    const checked = document.querySelector('input[type="radio"][name="poi-type"]:checked');
    pendingPoiTypeId = checked?.value || null;
    pendingPoiName = $("#add-poi-name")?.value?.trim() || "";
    pendingPoiDesc = $("#add-poi-desc")?.value?.trim() || "";
    if (!pendingPoiTypeId) return;
    closeAddPoiModal();
    document.body.classList.add("add-poi-armed");
  });

  $("#add-poi-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeAddPoiModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAddPoiModal();
  });

  // Keep export button in sync when custom POIs are added/removed
  window.addEventListener("custom-pois-changed", updateExportUi);
}

function openAddPoiModal() {
  buildAddPoiModalOptions();
  $("#add-poi-modal")?.classList.add("open");
  $("#add-poi-modal")?.setAttribute("aria-hidden", "false");
  $("#add-poi-name")?.focus();
}
function closeAddPoiModal() {
  $("#add-poi-modal")?.classList.remove("open");
  $("#add-poi-modal")?.setAttribute("aria-hidden", "true");
}

/* ---------- GPX loading (preserve original doc/route name) ---------- */
async function onFile(e) {
  try {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    originalFilename = f.name || "route.gpx";

    // NEW: optionally drop waypoints from the base GPX
    const drop = !!$("#opt-drop-wpts")?.checked;
    originalGpxXmlString = drop ? stripWaypointsFromGpx(text) : text;

    await showGpxText(originalGpxXmlString, originalFilename);
    drawSearchBoxAndCorridor();
    recomputeInsideFlagsForAllFetched();
    setPoiStatus("GPX loaded.");
    updateExportUi();
  } catch (err) {
    setPoiStatus(`Loading GPX failed: ${err?.message || err}`);
  }
}

async function onDrop(e) {
  e.preventDefault();
  try {
    const f = e.dataTransfer?.files?.[0];
    if (!f || !f.name?.toLowerCase().endsWith(".gpx")) {
      setTopStatus("Drop a .gpx file.");
      return;
    }
    const text = await f.text();
    originalFilename = f.name || "route.gpx";

    // NEW: optionally drop waypoints from the base GPX
    const drop = !!$("#opt-drop-wpts")?.checked;
    originalGpxXmlString = drop ? stripWaypointsFromGpx(text) : text;

    await showGpxText(originalGpxXmlString, originalFilename);
    drawSearchBoxAndCorridor();
    recomputeInsideFlagsForAllFetched();
    setPoiStatus("GPX loaded.");
    updateExportUi();
  } catch (err) {
    setPoiStatus(`Dropping GPX failed: ${err?.message || err}`);
  }
}

/* ---------- Auto sample ---------- */
const AUTO_SAMPLE_PATHS = ["./sample.gpx","./sample_with_waypoints.gpx","./data/sample.gpx"];
async function autoLoadSample() {
  for (const p of AUTO_SAMPLE_PATHS) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      originalFilename = p.split("/").pop() || "sample.gpx";
      originalGpxXmlString = text; // keep names intact
      await showGpxText(originalGpxXmlString, originalFilename);
      setTopStatus(`Loaded sample: ${originalFilename}`);
      return;
    } catch {}
  }
  setTopStatus("No default GPX found. Use the file picker.");
}

/* ---------- Render GPX & statuses ---------- */
async function showGpxText(text, label = "GPX") {
  const xml = new DOMParser().parseFromString(text, "text/xml");
  const gj = window.toGeoJSON.gpx(xml);
  renderTrackAndWaypoints(gj);
  setTopStatus(`Loaded: ${label} ✓`);
}

/* ---------- Corridor ---------- */
function corridorWidthM() {
  return Math.max(parseInt($("#poi-range-m")?.value || "100", 10), 1);
}
function getRouteBboxInflated() {
  const line = getRouteLine();
  if (!line) return null;
  const baseBbox = turf.bbox(line);
  const midLat = (baseBbox[1] + baseBbox[3]) / 2;
  const bbox = inflateBboxForRadius(baseBbox, FETCH_BBOX_RADIUS_M, midLat);
  return { bbox, line };
}
function inflateBboxForRadius(bbox, radiusM, midLat) {
  const [minx, miny, maxx, maxy] = bbox;
  const degPerMlat = 1.0 / 111320.0;
  const cosLat = Math.max(Math.cos((midLat * Math.PI) / 180), 1e-6);
  const degPerMlon = 1.0 / (111320.0 * cosLat);
  const dx = radiusM * degPerMlon;
  const dy = radiusM * degPerMlat;
  return [minx - dx, miny - dy, maxx + dx, maxy + dy];
}
function drawSearchBoxAndCorridor() {
  try {
    const obj = getRouteBboxInflated();
    if (!obj) return;
    const { bbox, line } = obj;
    drawSearchBox(bbox);
    const buffered = turf.buffer(line, Math.max(corridorWidthM() / 1000, 0.005), { units: "kilometers" });
    CORRIDOR_POLY = (buffered.type === "FeatureCollection" ? buffered.features[0] : buffered);
    drawCorridor(CORRIDOR_POLY);
    setTimeout(() => getMap()?.invalidateSize(), 0);
  } catch {}
}

/* ---------- Inside recompute (called on corridor changes & after fetch) ---------- */
function recomputeInsideFlagsForAllFetched() {
  if (!ALL_FETCHED_POIS.length) return;
  for (const f of ALL_FETCHED_POIS) {
    try {
      const [lon, lat] = f?.geometry?.coordinates || [];
      const pt = turf.point([lon, lat]);
      f.properties = f.properties || {};
      f.properties._inside = (CORRIDOR_POLY && Number.isFinite(lat) && Number.isFinite(lon))
        ? turf.booleanPointInPolygon(pt, CORRIDOR_POLY)
        : false;
    } catch {
      if (!f.properties) f.properties = {};
      f.properties._inside = false;
    }
  }
}

/* ---------- Fetching ---------- */
function selectedOverpassItems() {
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const selIds = cbs.filter(cb => cb.checked).map(cb => cb.getAttribute("data-op"));
  return (OVERPASS?.items || []).filter(x => selIds.includes(x.id));
}

async function onFetchSelected() {
  const route = getRouteBboxInflated();
  if (!route) { setPoiStatus("Load a GPX route first."); return; }
  const items = selectedOverpassItems();
  await fetchAndRender(route.bbox, items);
}

async function onFetchAll() {
  const route = getRouteBboxInflated();
  if (!route) { setPoiStatus("Load a GPX route first."); return; }
  await fetchAndRender(route.bbox, OVERPASS?.items || []);
}

async function fetchAndRender(bbox, items) {
  try {
    setPoiStatus("Fetching POIs…");
    const q = buildOverpassQueryFromConfig(bbox, items, 90);
    const json = await overpassFetch(q);
    const features = toFeatures(json, items);
    rememberFetchedPois(features);
    setPoiStatus(`Fetched ${features.length} POIs.`);
    updateExportUi();
  } catch (e) {
    setPoiStatus(`Fetch failed: ${e?.message || e}`);
  }
}

/** Convert Overpass JSON → GeoJSON Feature[] with:
 *  - geometry: Point([lon,lat]) from node or way center
 *  - properties: { ...tags, _type, _iconUrl, _distance_m, _snap:[lon,lat] }
 * Mapping of tags→wahoo_id is driven ONLY by selected items (config).
 */
function toFeatures(overpassJson, selectedItems) {
  const els = Array.isArray(overpassJson?.elements) ? overpassJson.elements : [];
  const byId = new Map();
  const line = getRouteLine();

  const rules = (selectedItems || []).map(it => ({
    wahoo: it.wahoo_id,
    defs: Array.isArray(it.tags) ? it.tags : (Array.isArray(it.overpass) ? it.overpass : [])
  }));

  const iconForType = (wahooType) => WAHOO_ITEM_BY_ID.get(wahooType)?.icon || null;

  els.forEach(el => {
    const tags = el.tags || {};
    const id = `${el.type}/${el.id}`;

    const lon = (el.lon != null) ? el.lon : (el.center?.lon);
    const lat = (el.lat != null) ? el.lat : (el.center?.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // Pick the FIRST matching rule from config; else generic.
    let wType = "generic";
    for (const r of rules) {
      if (r.defs.some(d => tags[d.k] === d.v)) { wType = r.wahoo; break; }
    }

    const icon = iconForType(wType);

    // snap + distance (meters) to current route
    let snap = null, distM = null;
    if (line) {
      try {
        const pt = turf.point([lon, lat]);
        const snapped = turf.nearestPointOnLine(line, pt, { units: "meters" });
        snap  = [snapped.geometry.coordinates[0], snapped.geometry.coordinates[1]];
        distM = Math.round(turf.distance(pt, snapped, { units: "meters" }));
      } catch {}
    }

    const f = {
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        ...tags,
        _type: wType,
        _iconUrl: icon || undefined,
        _distance_m: distM ?? undefined,
        _snap: snap ?? undefined
      }
    };
    byId.set(id, f);
  });

  return Array.from(byId.values());
}

/* ---------- Public hook called after a fetch ---------- */
function rememberFetchedPois(features = []) {
  ALL_FETCHED_POIS = Array.isArray(features) ? features.slice() : [];
  // Mark inside/outside based on current corridor
  recomputeInsideFlagsForAllFetched();
  updatePoiLayers();
}
window.rememberFetchedPois = rememberFetchedPois;

/* ---------- Selection + layers + export state ---------- */
function selectedWahooIds() {
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const set = new Set();
  cbs.forEach(cb => {
    if (cb.checked) {
      const wId = cb.getAttribute("data-wahoo");
      if (wId) set.add(wId);
    }
  });
  return set;
}

function updatePoiLayers() {
  renderAllPoisGhosted(ALL_FETCHED_POIS);

  const sel = selectedWahooIds();
  const insideSelected = ALL_FETCHED_POIS.filter(f => {
    const t = f?.properties?._type || f?.properties?.type || f?.properties?.wahoo_id;
    const inside = !!f?.properties?._inside;
    return inside && sel.has(String(t));
  });

  LAST_INSIDE_SELECTED = insideSelected;
  renderSelectedPois(insideSelected, SHOW_DISTANCE_LINES);
}

/* ---------- Export button state + handler ---------- */
function updateExportUi() {
  const btn = $("#btn-download-gpx");
  if (!btn) return;

  const base = (originalFilename || "route.gpx").replace(/\.gpx$/i, "");
  btn.setAttribute("download", `${base}_enriched.gpx`);

  const custom = listCustomPois();
  const canExport = !!(originalGpxXmlString && (LAST_INSIDE_SELECTED.length > 0 || custom.length > 0));
  btn.classList.toggle("disabled", !canExport);

  if (!canExport) {
    btn.removeAttribute("href");
    return;
  }

  // Fetched inside + selected (corridor filter)
  const exportFetched = LAST_INSIDE_SELECTED.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    const tags = f.properties || {};
    return {
      lat, lon,
      _type: tags._type || tags.type,
      _distance_m: tags._distance_m,
      tags
    };
  });

  // Plus ALL custom POIs (always export)
  const exportCustom = custom.map(p => ({
    lat: p.lat,
    lon: p.lon,
    _type: p.type,
    _distance_m: null,
    tags: { name: p.label }
  }));

  const enriched = addPoisAsWaypointsToGpx(originalGpxXmlString, [...exportFetched, ...exportCustom]);
  const blob = new Blob([enriched], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  btn.setAttribute("href", url);
}

/* ---------- Helpers ---------- */
function setTopStatus(m) { const el = $("#status"); if (el) el.textContent = m || ""; }
function setPoiStatus(m) { const el = $("#poi-status"); if (el) el.textContent = m || ""; }
function showBootError(msg) {
  const box = $("#boot-error"); if (!box) return;
  box.textContent = `Startup error: ${msg}`;
  box.style.display = "block";
}
