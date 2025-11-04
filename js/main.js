import { $, $$, debounce } from "./util.js";
import {
  initMap,
  getMap,
  renderTrackAndWaypoints,
  getRouteLine,
  drawCorridor,
  addCustomPoi,
  renderAllPoisGhosted,
  renderSelectedPois,
  listCustomPois,
  drawSearchPolygon,
  clearCustomPois,
} from "./mapview.js";
import {
  buildOverpassQueryFromConfigPoly,
  overpassFetch
} from "./overpass.js";
import { addPoisAsWaypointsToGpx, stripWaypointsFromGpx } from "./gpx.js";

const CDN_FALLBACKS = {
  leaflet_js:  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
  leaflet_css: "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css",
  togeojson:   "https://cdn.jsdelivr.net/npm/@tmcw/togeojson",
  turf:        "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js",
};
function loadScriptOnce(src) { return new Promise((resolve, reject) => { if ([...document.scripts].some(s => s.src === src)) return resolve(); const el = document.createElement("script"); el.src = src; el.async = true; el.onload = () => resolve(); el.onerror = () => reject(new Error(`Failed loading ${src}`)); document.head.appendChild(el); }); }
function loadCssOnce(href) { if ([...document.styleSheets].some(ss => ss.href === href)) return; const el = document.createElement("link"); el.rel = "stylesheet"; el.href = href; document.head.appendChild(el); }
async function ensureLibsLoaded() {
  const needLeaflet = !window.L, needTgj = !window.toGeoJSON, needTurf = !window.turf;
  if (needLeaflet) { loadCssOnce(CDN_FALLBACKS.leaflet_css); try { await loadScriptOnce(CDN_FALLBACKS.leaflet_js); } catch {} }
  if (!window.L) return { ok:false, reason:"Leaflet failed to load" };
  if (needTgj) { try { await loadScriptOnce(CDN_FALLBACKS.togeojson); } catch {} }
  if (!window.toGeoJSON) return { ok:false, reason:"toGeoJSON failed to load" };
  if (needTurf) { try { await loadScriptOnce(CDN_FALLBACKS.turf); } catch {} }
  if (!window.turf) return { ok:false, reason:"Turf.js failed to load" };
  return { ok:true };
}

/* ---------- Config state ---------- */
let PLATFORM = "wahoo";
let POI_TYPES = { version: 1, categories: [] };          // from ./config/<platform>/poi_types.json
let OVERPASS = { version: 1, items: [] };                // from ./config/overpass.json
let MAPPING = { version: 1, map: {} };                   // from ./config/<platform>/overpass_mapping.json

const TYPE_BY_ID = new Map();
const CATEGORY_ORDER = [];
const CATEGORY_META = new Map();

/* ---------- App state ---------- */
let originalGpxXmlString = "";
let originalFilename = "route.gpx";
let pendingPoiTypeId = null, pendingPoiName = "", pendingPoiDesc = "";

/* ---------- POI render state ---------- */
let ALL_FETCHED_POIS = [];
let LAST_EXPORT_SET = [];
let SEARCH_POLY = null;
let CORRIDOR_POLY = null;
let SHOW_DISTANCE_LINES = true;
const FORCED_EXPORT = new Set(); // feature IDs

/* ---------- Live status text ---------- */
let POI_UI_MSG = "";

/* ---------- Responsive ---------- */
function isMobile() { try { return (window.matchMedia && matchMedia("(max-width: 820px)").matches) || window.innerWidth <= 820; } catch { return window.innerWidth <= 820; } }
function applyInitialPanelState() {
  const mob = isMobile();
  document.body.classList.toggle("mob", mob);
  const lp = $("#left-panel"), rp = $("#right-panel");
  if (mob) { lp?.classList.remove("open"); rp?.classList.remove("open"); }
  else { lp?.classList.add("open"); rp?.classList.add("open"); }
  setTimeout(() => getMap()?.invalidateSize(), 0);
}

/* ---------- Errors ---------- */
let _bootErrorShown = false;
window.addEventListener("error", (e) => { const msg = e?.message || "Unknown error"; if (_bootErrorShown) return; showBootError(msg); });
window.addEventListener("unhandledrejection", (e) => { const msg = e?.reason?.message || e?.reason || "Unhandled rejection"; if (_bootErrorShown) return; showBootError(String(msg)); });

/* ---------- Startup ---------- */
let __started = false;
async function startApp() {
  if (__started) return; __started = true;
  try {
    const libs = await ensureLibsLoaded();
    if (!libs.ok) { showBootError(`${libs.reason}. In-app browsers sometimes block CDNs. Open in your browser or try again.`); return; }

    initMap();
    hookMapClicksForPlacement();

    await loadConfigsSafe();
    indexConfigs();

    window.getWahooIconUrl = (id) => {
      const key = String(id || "").trim().toLowerCase();
      const known = TYPE_BY_ID.get(key)?.icon || null;
      return known || "icons/undefined.svg";
    };

    buildPoiPanel();
    buildAddPoiModalOptions();
    hookUi();

    applyInitialPanelState();
    addEventListener("resize", applyInitialPanelState);

    await autoLoadSample();

    drawSearchAndCorridorPolys();
    setPoiStatus("Choose POIs and fetch.");
    updateExportUi();
    updateCountsStatus();
  } catch (err) { showBootError(err?.stack || err?.message || String(err)); }
}
if (document.readyState === "loading") { window.addEventListener("DOMContentLoaded", startApp, { once: true }); } else { startApp(); }

/* ---------- Config load/index ---------- */
async function loadConfigsSafe() {
  try { const res = await fetch("./config/overpass.json", { cache: "no-store" }); if (res.ok) OVERPASS = await res.json(); } catch {}
  try { const res = await fetch(`./config/${PLATFORM}/poi_types.json`, { cache: "no-store" }); if (res.ok) POI_TYPES = await res.json(); } catch {}
  try { const res = await fetch(`./config/${PLATFORM}/overpass_mapping.json`, { cache: "no-store" }); if (res.ok) MAPPING = await res.json(); } catch {}
}
function indexConfigs() {
  TYPE_BY_ID.clear(); CATEGORY_ORDER.length = 0; CATEGORY_META.clear();
  (POI_TYPES?.categories || []).forEach(cat => {
    CATEGORY_ORDER.push(cat.id);
    CATEGORY_META.set(cat.id, { label: cat.label, color: cat.color || "gray", defaultExpanded: !!cat.defaultExpanded });
    (cat.items || []).forEach(it => {
      TYPE_BY_ID.set(it.id, { ...it, categoryId: cat.id, categoryLabel: cat.label, color: cat.color || "gray" });
    });
  });
}

/* ---------- Build POI panel ---------- */
function buildPoiPanel() {
  const wrap = $("#poi-groups"); if (!wrap) return;
  wrap.innerHTML = "";

  const byCat = new Map();
  (OVERPASS?.items || []).forEach(op => {
    const mappedTypeId = MAPPING?.map?.[op.id] || "generic";
    const w = TYPE_BY_ID.get(mappedTypeId);
    if (!w) return;
    if (!byCat.has(w.categoryId)) byCat.set(w.categoryId, []);
    byCat.get(w.categoryId).push({ op, w, mappedTypeId });
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
    head.innerHTML = `<span class="pill ${color}" aria-hidden="true"></span>
      <span class="poi-cat-title">${catLabel}</span>
      <span class="poi-cat-actions">
        <button type="button" class="btn-mini act-all">Select all</button>
        <button type="button" class="btn-mini act-none">Unselect all</button>
      </span>`;
    catEl.appendChild(head);

    const body = document.createElement("div");
    body.className = "poi-cat-body";

    rows.forEach(({op, w, mappedTypeId}) => {
      const row = document.createElement("label");
      row.className = "poi-row";
      const checked = op.defaultSelected ? "checked" : "";
      const icon = w.icon || "";
      row.innerHTML = `<input type="checkbox" data-op="${op.id}" data-type="${mappedTypeId}" ${checked}/>
        <img src="${icon}" alt="${w.id}" onerror="this.style.display='none'"/>
        <span>${op.label}</span>
        <span class="map-chip">${w.id}</span>`;
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
  updateCountsStatus();
}

/* ---------- Selected chips ---------- */
function renderSelectedChips() {
  const chipsEl = $("#selected-chips"); if (!chipsEl) return;
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const sel = cbs.filter(cb => cb.checked).map(cb => cb.getAttribute("data-op"));

  chipsEl.innerHTML = "";
  sel.forEach(opId => {
    const op = (OVERPASS?.items || []).find(x => x.id === opId);
    if (!op) return;
    const mapped = MAPPING?.map?.[op.id] || "generic";
    const w = TYPE_BY_ID.get(mapped);
    if (!w) return;
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.title = "Click to unselect";
    chip.innerHTML = `<img src="${w.icon||""}" alt="${w.id}" onerror="this.style.display='none'"/><span>${op.label}</span>`;
    chip.addEventListener("click", () => {
      const cb = $(`#poi-groups input[data-op="${op.id}"]`);
      if (cb) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    chipsEl.appendChild(chip);
  });
}

/* ---------- Add-POI modal ---------- */
function buildAddPoiModalOptions() {
  const list = $("#add-poi-types"); if (!list) return;
  list.innerHTML = "";
  (POI_TYPES?.categories || []).forEach(cat => {
    const box = document.createElement("div");
    box.className = "type-cat";
    const head = document.createElement("div");
    head.className = "type-cat-head";
    head.textContent = cat.label;
    box.appendChild(head);
    const items = document.createElement("div");
    items.className = "type-items";
    (cat.items || []).slice().sort((a,b) => a.label.localeCompare(b.label)).forEach(it => {
      const row = document.createElement("label");
      row.className = "type-row";
      row.innerHTML = `<input type="radio" name="poi-type" value="${it.id}">
        <img src="${it.icon||""}" alt="${it.id}" onerror="this.style.display='none'"/>
        <span>${it.label}</span>`;
      items.appendChild(row);
    });
    box.appendChild(items);
    list.appendChild(box);
  });
  const first = list.querySelector('input[type="radio"][name="poi-type"]');
  if (first) first.checked = true;
}

/* ---------- Map click to place POI ---------- */
function hookMapClicksForPlacement() {
  const map = getMap(); if (!map) return;
  map.on("click", (e) => {
    if (!document.body.classList.contains("add-poi-armed")) return;
    if (!pendingPoiTypeId) return;
    const { lat, lng } = e.latlng;
    const typeMeta = TYPE_BY_ID.get(pendingPoiTypeId);
    const iconUrl = typeMeta?.icon || null;
    const name = pendingPoiName || typeMeta?.label || pendingPoiTypeId;
    const desc = pendingPoiDesc || "";
    addCustomPoi(lat, lng, pendingPoiTypeId, name, desc, iconUrl);
    updateExportUi();
    updateCountsStatus();
    document.body.classList.remove("add-poi-armed");
    pendingPoiTypeId = null; pendingPoiName = ""; pendingPoiDesc = "";
  });
}

/* ---------- UI hooks ---------- */
function hookUi() {
  $("#file")?.addEventListener("change", onFile);
  addEventListener("dragover", e => e.preventDefault());
  addEventListener("drop", onDrop);

  const onAnyRangeChange = debounce(() => {
    drawSearchAndCorridorPolys();
    recomputeInsideFlagsForAllFetched();
    updatePoiLayers();
    updateExportUi();
    updateCountsStatus();
  }, 120);

  $("#poi-range-m")?.addEventListener("input", onAnyRangeChange);
  $("#poi-range-m")?.addEventListener("change", onAnyRangeChange);
  $("#search-range-m")?.addEventListener("input", onAnyRangeChange);
  $("#search-range-m")?.addEventListener("change", onAnyRangeChange);

  // NEW: ROI subsampling control hooks
  $("#roi-maxpoints")?.addEventListener("input", onAnyRangeChange);
  $("#roi-maxpoints")?.addEventListener("change", onAnyRangeChange);

  $("#toggle-lines")?.addEventListener("change", () => { SHOW_DISTANCE_LINES = !!$("#toggle-lines")?.checked; updatePoiLayers(); });

  $("#btn-toggle-left")?.addEventListener("click", () => {
    const el = $("#left-panel"); const on = !el.classList.contains("open");
    el.classList.toggle("open", on); $("#btn-toggle-left").setAttribute("aria-pressed", on ? "true" : "false");
    setTimeout(() => getMap()?.invalidateSize(), 0);
  });
  $("#btn-toggle-right")?.addEventListener("click", () => {
    const el = $("#right-panel"); const on = !el.classList.contains("open");
    el.classList.toggle("open", on); $("#btn-toggle-right").setAttribute("aria-pressed", on ? "true" : "false");
    setTimeout(() => getMap()?.invalidateSize(), 0);
  });

  $("#btn-fetch-selected")?.addEventListener("click", onFetchSelected);
  $("#btn-fetch-all")?.addEventListener("click", onFetchAll);

  $("#btn-download-gpx")?.addEventListener("click", (e) => { if ($("#btn-download-gpx")?.classList.contains("disabled")) e.preventDefault(); });

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
  $("#add-poi-modal")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeAddPoiModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAddPoiModal(); });

  window.addEventListener("custom-pois-changed", () => { updateExportUi(); updateCountsStatus(); });

  // Template switcher
  $("#platform-select")?.addEventListener("change", async (e) => { PLATFORM = e.target.value || "wahoo"; await reloadTemplate(); });

  // Forced export toggle (from map popups)
  window.toggleForcedExport = (id) => {
    if (FORCED_EXPORT.has(id)) FORCED_EXPORT.delete(id);
    else FORCED_EXPORT.add(id);
    updatePoiLayers();
    updateExportUi();
    updateCountsStatus();
  };
}

async function reloadTemplate() {
  ALL_FETCHED_POIS = []; LAST_EXPORT_SET = []; FORCED_EXPORT.clear(); clearCustomPois();
  renderAllPoisGhosted([]); renderSelectedPois([], SHOW_DISTANCE_LINES);
  await loadConfigsSafe(); indexConfigs();
  buildPoiPanel(); buildAddPoiModalOptions();
  setPoiStatus(`Template switched to ${PLATFORM}.`);
  updateExportUi(); updateCountsStatus();
}

function openAddPoiModal() { buildAddPoiModalOptions(); $("#add-poi-modal")?.classList.add("open"); $("#add-poi-modal")?.setAttribute("aria-hidden", "false"); $("#add-poi-name")?.focus(); }
function closeAddPoiModal() { $("#add-poi-modal")?.classList.remove("open"); $("#add-poi-modal")?.setAttribute("aria-hidden", "true"); }

/* ---------- GPX loading ---------- */
async function onFile(e) {
  try {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text(); originalFilename = f.name || "route.gpx";
    const drop = !!$("#opt-drop-wpts")?.checked; originalGpxXmlString = drop ? stripWaypointsFromGpx(text) : text;
    await showGpxText(originalGpxXmlString, originalFilename);
    drawSearchAndCorridorPolys(); recomputeInsideFlagsForAllFetched();
    setPoiStatus("GPX loaded."); updateExportUi(); updateCountsStatus();
  } catch (err) { setPoiStatus(`Loading GPX failed: ${err?.message || err}`); }
}
async function onDrop(e) {
  e.preventDefault();
  try {
    const f = e.dataTransfer?.files?.[0];
    if (!f || !f.name?.toLowerCase().endsWith(".gpx")) { setTopStatus("Drop a .gpx file."); return; }
    const text = await f.text(); originalFilename = f.name || "route.gpx";
    const drop = !!$("#opt-drop-wpts")?.checked; originalGpxXmlString = drop ? stripWaypointsFromGpx(text) : text;
    await showGpxText(originalGpxXmlString, originalFilename);
    drawSearchAndCorridorPolys(); recomputeInsideFlagsForAllFetched();
    setPoiStatus("GPX loaded."); updateExportUi(); updateCountsStatus();
  } catch (err) { setPoiStatus(`Dropping GPX failed: ${err?.message || err}`); }
}

/* ---------- Auto sample ---------- */
const AUTO_SAMPLE_PATHS = ["./sample.gpx"];
async function autoLoadSample() {
  for (const p of AUTO_SAMPLE_PATHS) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      originalFilename = p.split("/").pop() || "sample.gpx";
      originalGpxXmlString = text;
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

/* ---------- Geometry helpers for performance ---------- */
function thinCoords(coords, maxPoints) {
  const n = Array.isArray(coords) ? coords.length : 0;
  if (n <= maxPoints) return coords.slice();
  const step = Math.ceil(n / maxPoints);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(coords[i]);
  if (out[out.length - 1] !== coords[n - 1]) out.push(coords[n - 1]);
  return out;
}
function lightweightLine(feature, maxPerPart = 4000) {
  if (!feature) return null;
  const isFeat = feature.type === "Feature";
  const geom = isFeat ? feature.geometry : feature;
  if (!geom) return null;

  if (geom.type === "LineString") {
    const coords = thinCoords(geom.coordinates || [], maxPerPart);
    return isFeat ? { ...feature, geometry: { type: "LineString", coordinates: coords } }
                  : { type: "LineString", coordinates: coords };
  }
  if (geom.type === "MultiLineString") {
    const parts = (geom.coordinates || []).map(part => thinCoords(part || [], maxPerPart));
    return isFeat ? { ...feature, geometry: { type: "MultiLineString", coordinates: parts } }
                  : { type: "MultiLineString", coordinates: parts };
  }
  return feature;
}
// NEW: read UI value (with sensible bounds)
function roiMaxPoints() {
  const el = $("#roi-maxpoints");
  const val = parseInt(el?.value || "4000", 10);
  const x = Number.isFinite(val) ? val : 4000;
  // clamp to avoid silly values
  return Math.min(Math.max(x, 500), 20000);
}

/* ---------- Polygons ---------- */
function searchWidthM() {
  const v = parseInt($("#search-range-m")?.value || "500", 10);
  return Number.isFinite(v) ? v : 500;
}
function corridorWidthM() { return Math.max(parseInt($("#poi-range-m")?.value || "100", 10), 1); }
function drawSearchAndCorridorPolys() {
  try {
    const baseLine = getRouteLine(); if (!baseLine) return;

    // Use UI-configured lightweight copy for heavy ops
    const lineOps = lightweightLine(baseLine, roiMaxPoints());

    const searchBuf = turf.buffer(lineOps, Math.max(searchWidthM() / 1000, 0.01), { units: "kilometers", steps: 16 });
    const searchSimp = turf.simplify(searchBuf, { tolerance: 0.0008, highQuality: false });
    const searchTrunc = turf.truncate(searchSimp, { precision: 5, coordinates: 2 });
    SEARCH_POLY = (searchTrunc.type === "FeatureCollection") ? searchTrunc.features[0] : searchTrunc;
    drawSearchPolygon(SEARCH_POLY);

    const corridorBuf = turf.buffer(lineOps, Math.max(corridorWidthM() / 1000, 0.01), { units: "kilometers", steps: 12 });
    const corridorTrunc = turf.truncate(corridorBuf, { precision: 5, coordinates: 2 });
    CORRIDOR_POLY = (corridorTrunc.type === "FeatureCollection") ? corridorTrunc.features[0] : corridorTrunc;

    drawCorridor(CORRIDOR_POLY);
    setTimeout(() => getMap()?.invalidateSize(), 0);
  } catch {}
}

/* ---------- Inside recompute ---------- */
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
    } catch { if (!f.properties) f.properties = {}; f.properties._inside = false; }
  }
}

/* ---------- Fetching ---------- */
function selectedOverpassItems() {
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const selIds = cbs.filter(cb => cb.checked).map(cb => cb.getAttribute("data-op"));
  return (OVERPASS?.items || []).filter(x => selIds.includes(x.id));
}
async function onFetchSelected() { if (!SEARCH_POLY) { setPoiStatus("Load a GPX route first."); return; } const items = selectedOverpassItems(); await fetchAndRender(SEARCH_POLY, items); }
async function onFetchAll() { if (!SEARCH_POLY) { setPoiStatus("Load a GPX route first."); return; } await fetchAndRender(SEARCH_POLY, OVERPASS?.items || []); }

async function fetchAndRender(searchPoly, items) {
  try {
    setPoiStatus("Fetching POIs…");
    const q = buildOverpassQueryFromConfigPoly(searchPoly, items, 90);
    const json = await overpassFetch(q);
    const features = toFeatures(json, items);
    rememberFetchedPois(features);
    setPoiStatus(`Fetched ${features.length} POIs.`);
    updateExportUi(); updateCountsStatus();
  } catch (e) { setPoiStatus(`Fetch failed: ${e?.message || e}`); }
}

/** Convert Overpass JSON → GeoJSON Feature[] */
function toFeatures(overpassJson, selectedItems) {
  const els = Array.isArray(overpassJson?.elements) ? overpassJson.elements : [];
  const byId = new Map();
  const baseLine = getRouteLine();
  const lineForOps = baseLine ? lightweightLine(baseLine, roiMaxPoints()) : null;

  // Rules: map each selected item to its target poi_type via MAPPING
  const rules = (selectedItems || []).map(it => ({
    poiTypeId: (MAPPING?.map?.[it.id] || "generic"),
    itemId: it.id,
    ors: Array.isArray(it.tags) ? it.tags : [],
    ands: Array.isArray(it.tagsAll) ? it.tagsAll : []
  }));

  const iconForType = (poiType) => TYPE_BY_ID.get(poiType)?.icon || null;

  els.forEach(el => {
    const tags = el.tags || {};
    theId: {
      const id = `${el.type}/${el.id}`;
      const lon = (el.lon != null) ? el.lon : (el.center?.lon);
      const lat = (el.lat != null) ? el.lat : (el.center?.lat);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) break theId;

      let typeId = "generic";
      for (const r of rules) {
        const orMatch = r.ors.length ? r.ors.some(d => tags[d.k] === d.v) : false;
        const andMatch = r.ands.length ? r.ands.every(d => tags[d.k] === d.v) : false;
        if (orMatch || andMatch) { typeId = r.poiTypeId; break; }
      }
      const icon = iconForType(typeId);

      let snap = null, distM = null;
      if (lineForOps) {
        try {
          const pt = turf.point([lon, lat]);
          const snapped = turf.nearestPointOnLine(lineForOps, pt, { units: "meters" });
          snap  = [snapped.geometry.coordinates[0], snapped.geometry.coordinates[1]];
          distM = Math.round(turf.distance(pt, snapped, { units: "meters" }));
        } catch {}
      }

      const f = { type: "Feature", id, geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { ...tags, _type: typeId, _iconUrl: icon || undefined, _distance_m: distM ?? undefined, _snap: snap ?? undefined, _forced: false } };
      byId.set(id, f);
    }
  });

  return Array.from(byId.values());
}

/* ---------- After fetch ---------- */
function rememberFetchedPois(features = []) {
  ALL_FETCHED_POIS = Array.isArray(features) ? features.slice() : [];
  recomputeInsideFlagsForAllFetched();
  updatePoiLayers();
}
window.rememberFetchedPois = rememberFetchedPois;

/* ---------- Selection + layers + export state ---------- */
function selectedTypeIds() {
  const cbs = $$('#poi-groups input[type="checkbox"][data-op]');
  const set = new Set();
  cbs.forEach(cb => { if (cb.checked) { const tId = cb.getAttribute("data-type"); if (tId) set.add(tId); } });
  return set;
}
function updatePoiLayers() {
  for (const f of ALL_FETCHED_POIS) { f.properties = f.properties || {}; f.properties._forced = FORCED_EXPORT.has(f.id); }
  renderAllPoisGhosted(ALL_FETCHED_POIS);

  const selTypes = selectedTypeIds();
  const insideSelected = ALL_FETCHED_POIS.filter(f => {
    const t = f?.properties?._type || f?.properties?.type;
    const inside = !!f?.properties?._inside;
    return inside && selTypes.has(String(t));
  });

  const forced = ALL_FETCHED_POIS.filter(f => FORCED_EXPORT.has(f.id));
  const union = [...insideSelected]; const seen = new Set(insideSelected.map(f => f.id));
  forced.forEach(f => { if (!seen.has(f.id)) union.push(f); });

  LAST_EXPORT_SET = union;
  renderSelectedPois(union, SHOW_DISTANCE_LINES);
}

/* ---------- Export button state ---------- */
function updateExportUi() {
  const btn = $("#btn-download-gpx"); if (!btn) return;
  const base = (originalFilename || "route.gpx").replace(/\.gpx$/i, "");
  btn.setAttribute("download", `${base}_enriched.gpx`);

  const custom = listCustomPois();
  const canExport = !!(originalGpxXmlString && (LAST_EXPORT_SET.length > 0 || custom.length > 0));
  btn.classList.toggle("disabled", !canExport);
  if (!canExport) { btn.removeAttribute("href"); return; }

  const exportFetched = LAST_EXPORT_SET.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    const tags = f.properties || {};
    return { lat, lon, _type: tags._type || tags.type, _distance_m: tags._distance_m, tags };
  });
  const exportCustom = custom.map(p => ({ lat: p.lat, lon: p.lon, _type: p.type, _distance_m: null, tags: { name: p.label } }));
  const enriched = addPoisAsWaypointsToGpx(originalGpxXmlString, [...exportFetched, ...exportCustom]);
  const blob = new Blob([enriched], { type: "application/gpx+xml" });
  const urlOld = btn.getAttribute("href"); if (urlOld) try { URL.revokeObjectURL(urlOld); } catch {}
  const url = URL.createObjectURL(blob); btn.setAttribute("href", url);
}

/* ---------- Counts + status ---------- */
function computeCounts() {
  const totalFetched = ALL_FETCHED_POIS.length;
  const inCorridor = ALL_FETCHED_POIS.reduce((n, f) => n + (f?.properties?._inside ? 1 : 0), 0);
  const selectedInCorridor = ALL_FETCHED_POIS.reduce((n, f) => {
    const selTypes = selectedTypeIds();
    const t = f?.properties?._type || f?.properties?.type;
    return n + ((f?.properties?._inside && selTypes.has(String(t))) ? 1 : 0);
  }, 0);
  const forcedCount = FORCED_EXPORT.size;
  const customCount = listCustomPois().length;
  const exportTotal = LAST_EXPORT_SET.length + customCount;
  return { totalFetched, inCorridor, selectedInCorridor, forcedCount, customCount, exportTotal };
}
function countsText() {
  const { totalFetched, inCorridor, selectedInCorridor, forcedCount, customCount, exportTotal } = computeCounts();
  return `fetched: ${totalFetched} | in corridor: ${inCorridor} | selected in corridor: ${selectedInCorridor} | forced: ${forcedCount} | custom: ${customCount} | export: ${exportTotal}`;
}
function renderPoiStatus() { const el = $("#poi-status"); if (!el) return; const parts = []; if (POI_UI_MSG) parts.push(POI_UI_MSG); parts.push(countsText()); el.textContent = parts.join(" | "); }
function updateCountsStatus() { renderPoiStatus(); }

/* ---------- Helpers ---------- */
function setTopStatus(m) { const el = $("#status"); if (el) el.textContent = m || ""; }
function setPoiStatus(m) { POI_UI_MSG = m || ""; renderPoiStatus(); }
function showBootError(msg) {
  _bootErrorShown = true; const box = $("#boot-error"); if (!box) return;
  const nice = (String(msg).trim() === "Script error.")
    ? "A required library failed to load (blocked by in-app browser). Trying fallbacks… If it still doesn’t load, open this page in your default browser."
    : String(msg);
  box.textContent = `Startup error: ${nice}`; box.style.display = "block";
}
