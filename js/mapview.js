// js/mapview.js
import { esc, row } from "./util.js";
import { buildExportFields } from "./mapping.js";

// Map + layers
let map = null;
let trackLayer = null, waypointLayer = null;
let allPoisLayer = null, poisLayer = null, distanceLayer = null;
let searchBoxLayer = null, corridorLayer = null;
let customPoisLayer = null;

// Track custom POIs for export
let _customId = 0;
let _customPois = []; // { id, lat, lon, type, label, desc, iconUrl, marker }

export function initMap() {
  map = L.map("map");
  map.zoomControl.setPosition('bottomright');
  map.setView([48.2082, 16.3738], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  distanceLayer   = L.featureGroup().addTo(map);
  searchBoxLayer  = L.featureGroup().addTo(map);
  corridorLayer   = L.featureGroup().addTo(map);
  customPoisLayer = L.featureGroup().addTo(map);

  addEventListener("load", () => setTimeout(() => map.invalidateSize(), 0));
  return map;
}
export function getMap(){ return map; }

export function renderTrackAndWaypoints(gj) {
  const features = Array.isArray(gj?.features) ? gj.features : [];
  const track = features.find(f => f?.geometry?.type === "LineString");
  if (!track) { return; }

  if (trackLayer) trackLayer.remove();
  trackLayer = L.geoJSON(track, { style:{ weight:4 } }).addTo(map);
  map.fitBounds(trackLayer.getBounds(), { padding:[20,20] });

  const waypointFeatures = features.filter(f => f?.geometry?.type === "Point");
  if (waypointLayer) waypointLayer.remove();

  waypointLayer = L.geoJSON({ type:"FeatureCollection", features: waypointFeatures }, {
    pointToLayer: (f, latlng) => {
      const props = f?.properties || {};
      const wahooId = String(props.type || props.sym || "").trim();
      const iconUrl = (typeof window !== "undefined" && typeof window.getWahooIconUrl === "function")
        ? window.getWahooIconUrl(wahooId)
        : null;

      if (iconUrl) {
        return L.marker(latlng, {
          icon: L.icon({
            iconUrl,
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupAnchor: [0, -24],
            className: "poi-png"
          })
        });
      }
      return L.marker(latlng, { icon: fallbackDivIcon("W", true) });
    },
    onEachFeature: (f, layer) => {
      // Use original GPX props; compute a friendly fallback name if needed
      const p = f?.properties || {};
      const wahooId = (p.type || p.sym || "generic").toString().trim().toLowerCase();

      const { nameLabel: fallbackName } = buildExportFields(p, wahooId, null);
      const titleName = (p.name && String(p.name).trim()) || fallbackName;
      const descText  = (p.desc != null) ? String(p.desc) : "";

      // GPX snippet that preserves the original <desc> and sym/type
      const latlng = layer.getLatLng();
      let gpxBlock = "";
      if (latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)) {
        const symText = (p.type || p.sym || wahooId).toString().trim().toLowerCase();
        const gpx = buildGpxSnippet(latlng.lat, latlng.lng, titleName, descText, symText);
        gpxBlock = `
          <div class="subhead">GPX</div>
          <pre class="code">${esc(gpx)}</pre>
        `;
      }

      const rows = [];
      if (descText) rows.push(row("Description", descText));
      if (p.cmt)    rows.push(row("Comment", String(p.cmt)));
      if (p.type)   rows.push(row("Type", String(p.type)));
      if (p.sym)    rows.push(row("Symbol", String(p.sym)));

      layer.bindPopup(
        `<div class="popup">
          <div class="title">${maybeIconImgFromSym(wahooId)}<span>${esc(titleName)}</span></div>
          ${rows.join("") || "<div class='kv'><em>No extra info</em></div>"}
          ${gpxBlock}
        </div>`
      );
    }
  }).addTo(map);
}


export function getRouteLine() {
  if (!trackLayer) return null;
  const gj = trackLayer.toGeoJSON();
  return (gj.type === "FeatureCollection")
    ? (gj.features || []).find(f => f?.geometry?.type === "LineString")
    : gj;
}

export function drawSearchBox(bbox) {
  searchBoxLayer.clearLayers();
  const [minX, minY, maxX, maxY] = bbox;
  const rect = L.rectangle([[minY, minX], [maxY, maxX]], {
    color: "#0077ff", weight: 2, dashArray: "6 4", fill: false, opacity: 0.9
  });
  rect.addTo(searchBoxLayer);
}
export function drawCorridor(polyFeature) {
  corridorLayer.clearLayers();
  L.geoJSON(polyFeature, { style: { color: "#ff006e", weight: 2, dashArray: "4 4", fill: false }})
    .addTo(corridorLayer);
}

export function renderAllPoisGhosted(features) {
  if (allPoisLayer) { allPoisLayer.remove(); }
  allPoisLayer = L.geoJSON({type:"FeatureCollection",features}, {
    pointToLayer: (f, latlng) => L.marker(latlng, {
      icon: chooseIcon(f, true),
      opacity: 0.35
    }),
    onEachFeature: (f, layer) => {
      layer.bindPopup(buildPoiPopup(f, null, false));
    }
  }).addTo(map);
}

export function renderSelectedPois(features, showLines=true) {
  if (poisLayer) poisLayer.remove();
  if (distanceLayer) distanceLayer.clearLayers();

  poisLayer = L.geoJSON({type:"FeatureCollection",features}, {
    pointToLayer: (f, latlng) => L.marker(latlng, { icon: chooseIcon(f, false) }),
    onEachFeature: (f, layer) => {
      const d = f.properties?._distance_m || null;
      layer.bindPopup(buildPoiPopup(f, d, true));
    }
  }).addTo(map);

  if (showLines) {
    (features || []).forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const [sx, sy] = (f.properties?._snap || [null,null]);
      if (sx != null && sy != null) {
        L.polyline([[lat, lon], [sy, sx]], { color: "#ff006e", weight: 2, opacity: 0.9, dashArray: "4 4" })
          .addTo(distanceLayer);
      }
    });
  }
}

/* ---------- Custom POIs ---------- */

export function addCustomPoi(lat, lon, poiTypeId, label, desc = "", iconUrl = null) {
  const id = `custom:${++_customId}`;

  const icon = iconUrl
  ? L.icon({
      iconUrl,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -24],
      className: "poi-png"
    })
  : fallbackDivIcon("C");

  const m = L.marker([lat, lon], { icon }).addTo(customPoisLayer);

  // Unified export fields (match fetched)
  const tags = { name: label || "" };
  const { nameLabel, sym, desc: descLine } = buildExportFields(tags, (poiTypeId || "generic"), null);

  const latFixed = Number(lat).toFixed(5);
  const lonFixed = Number(lon).toFixed(5);

  const gpx = `<wpt lat="${latFixed}" lon="${lonFixed}">
  <name>${esc(nameLabel)}</name>
  <desc>${esc(descLine)}</desc>
  <sym>${esc(sym)}</sym>
  <type>${esc(sym)}</type>
</wpt>`;

  const iconImg = iconUrl ? `<img src="${iconUrl}" alt="${esc(sym)}" />` : "";

  const html = `
    <div class="popup">
      <div class="title">${iconImg}<span>${esc(nameLabel)}</span></div>
      ${desc ? row("Note", desc) : ""}
      ${row("Type", sym)}
      <div class="subhead">GPX</div>
      <pre class="code">${esc(gpx)}</pre>
      <div class="actions">
        <button class="btn-del" data-id="${id}">Delete</button>
      </div>
    </div>
  `;

  m.bindPopup(html);
  m._custom_id = id;

  // Track for export
  _customPois.push({ id, lat, lon, type: poiTypeId, label, desc, iconUrl, marker: m });
  window.dispatchEvent(new CustomEvent("custom-pois-changed"));

  m.on("popupopen", () => {
    const el = document.querySelector(`.btn-del[data-id="${id}"]`);
    if (el) el.addEventListener("click", () => {
      customPoisLayer.removeLayer(m);
      _customPois = _customPois.filter(p => p.id !== id);
      window.dispatchEvent(new CustomEvent("custom-pois-changed"));
    });
  });

  return { id, lat, lon, type: poiTypeId, label, desc, iconUrl };
}

/** Read-only list of custom POIs (for export) */
export function listCustomPois() {
  // Omit the Leaflet marker from the public copy
  return _customPois.map(({ marker, ...rest }) => ({ ...rest }));
}

/* ---------- Popups for fetched/ghosted POIs ---------- */
function buildPoiPopup(feature, distanceM, includeGpxSnippet=false) {
  const props = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [null, null];

  const wahooId = (props?._type || props?.type || "generic").toString().trim().toLowerCase();
  const { nameLabel, sym, desc } = buildExportFields(props, wahooId, distanceM);

  const rows = [];
  if (props?.name)          rows.push(row("Name", String(props.name)));
  if (props?.operator)      rows.push(row("Operator", String(props.operator)));
  if (props?.opening_hours) rows.push(row("Hours", String(props.opening_hours)));
  if (distanceM != null)    rows.push(row("Distance", `${distanceM} m`));

  let gpxBlock = "";
  if (includeGpxSnippet && Number.isFinite(lat) && Number.isFinite(lon)) {
    const gpx = buildGpxSnippet(lat, lon, nameLabel, desc, sym);
    gpxBlock = `
      <div class="subhead">GPX</div>
      <pre class="code">${esc(gpx)}</pre>
    `;
  }

  return `<div class="popup">
    <div class="title">${maybeIconImg(props, wahooId)}<span>${esc(nameLabel)}</span></div>
    ${rows.length ? rows.join("") : ""}
    ${gpxBlock}
  </div>`;
}

function buildGpxSnippet(lat, lon, name, desc, sym) {
  const escXml = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const latStr = Number(lat).toFixed(5);
  const lonStr = Number(lon).toFixed(5);
  return `<wpt lat="${latStr}" lon="${lonStr}">
  <name>${escXml(name)}</name>
  <desc>${escXml(desc)}</desc>
  <sym>${escXml(sym)}</sym>
  <type>${escXml(sym)}</type>
</wpt>`;
}

function maybeIconImg(props, fallbackSym=null) {
  const sym = (props?._type || props?.type || props?.sym || fallbackSym || "").toString().trim().toLowerCase();
  const url = props?._iconUrl || ((typeof window !== "undefined" && typeof window.getWahooIconUrl === "function")
        ? window.getWahooIconUrl(sym) : null);
  return url ? `<img src="${esc(url)}" alt="" />` : "";
}
function maybeIconImgFromSym(sym) {
  const url = (typeof window !== "undefined" && typeof window.getWahooIconUrl === "function")
    ? window.getWahooIconUrl(sym) : null;
  return url ? `<img src="${esc(url)}" alt="" />` : "";
}

function chooseIcon(f, ghost) {
  const props = f?.properties || {};
  const sym = (props?._type || props?.type || "").toString().trim().toLowerCase();
  const url = props._iconUrl || ((typeof window !== "undefined" && typeof window.getWahooIconUrl === "function")
        ? window.getWahooIconUrl(sym) : null);

  if (url) {
    return L.icon({
      iconUrl: url,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -24],
      className: "poi-png"
    });
  }
  return fallbackDivIcon(ghost ? "G" : "P", ghost);
}

function fallbackDivIcon(text = "?", ghost=false) {
  return L.divIcon({
    className: `poi-divicon${ghost ? " ghost": ""}`,
    html: `<span>${esc(String(text).slice(0,3))}</span>`,
    iconSize: [28,28],
    iconAnchor: [14,28],
    popupAnchor: [0,-24]
  });
}

export function getTrackLayer(){ return trackLayer; }
export function getLayers(){ return { trackLayer, waypointLayer, allPoisLayer, poisLayer, distanceLayer, searchBoxLayer, corridorLayer, customPoisLayer }; }
