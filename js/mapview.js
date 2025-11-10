import { esc, row } from "./util.js";
import { buildExportFields } from "./mapping.js";

let map = null;
let trackLayer = null, waypointLayer = null;
let allPoisLayer = null, poisLayer = null, distanceLayer = null;
let corridorLayer = null;
let searchPolyLayer = null;
let customPoisLayer = null;

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
  searchPolyLayer = L.featureGroup().addTo(map);
  corridorLayer   = L.featureGroup().addTo(map);
  customPoisLayer = L.featureGroup().addTo(map);

  addEventListener("load", () => setTimeout(() => map.invalidateSize(), 0));
  return map;
}
export function getMap(){ return map; }

export function renderTrackAndWaypoints(gj) {
  const features = Array.isArray(gj?.features) ? gj.features : [];
  const track = features.find(f => f?.geometry?.type === "LineString" || f?.geometry?.type === "MultiLineString");
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
      const p = f?.properties || {};
      const wahooIdLower = (p.type || p.sym || "generic").toString().trim().toLowerCase();

      // Use original casing for export-related fields where available
      const exportType = (p.type || p.sym || wahooIdLower).toString().trim();

      const { nameLabel: fallbackName } = buildExportFields(p, exportType, null);
      const titleName = (p.name && String(p.name).trim()) || fallbackName;
      const descText  = (p.desc != null) ? String(p.desc) : "";

      const latlng = layer.getLatLng();
      let gpxBlock = "";
      if (latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)) {
        const symText = exportType; // preserve exact casing in GPX
        const gpx = buildGpxSnippet(latlng.lat, latlng.lng, titleName, descText, symText);
        gpxBlock = `<div class="subhead">GPX</div><pre class="code">${esc(gpx)}</pre>`;
      }

      const rows = [];
      if (descText) rows.push(row("Description", descText));
      if (p.cmt)    rows.push(row("Comment", String(p.cmt)));
      if (p.type)   rows.push(row("Type", String(p.type)));
      if (p.sym)    rows.push(row("Symbol", String(p.sym)));

      layer.bindPopup(`<div class="popup">
          <div class="title">${maybeIconImgFromSym(wahooIdLower)}<span>${esc(titleName)}</span></div>
          ${rows.join("") || "<div class='kv'><em>No extra info</em></div>"}
          ${gpxBlock}
        </div>`);
    }
  }).addTo(map);
}

export function drawSearchPolygon(polyFeature) {
  try { searchPolyLayer.clearLayers(); } catch {}

  // 1) Visible search polygon outline (no fill).
  L.geoJSON(polyFeature, { style: { color: "#000000", weight: 1, fill: false, opacity: 0.7 }})
    .addTo(searchPolyLayer);

  // 2) Inverse dimmer outside the search polygon.
  try {
    const geom = polyFeature.type === "Feature" ? polyFeature.geometry : polyFeature;
    if (geom?.type === "Polygon" || geom?.type === "MultiPolygon") {
      const WORLD = [
        [-179.999, -85],
        [ 179.999, -85],
        [ 179.999,  85],
        [-179.999,  85],
        [-179.999, -85]
      ];

      const holes = [];
      if (geom.type === "Polygon" && Array.isArray(geom.coordinates?.[0])) {
        holes.push(geom.coordinates[0]);
      } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates?.[0]?.[0])) {
        holes.push(geom.coordinates[0][0]);
      }

      if (holes.length) {
        const inv = {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [WORLD, ...holes]
          },
          properties: {}
        };

        L.geoJSON(inv, {
          interactive: false,
          style: {
            color: "#000000",
            weight: 0,
            fill: true,
            fillOpacity: 0.2,
            fillRule: "evenodd"
          }
        }).addTo(searchPolyLayer);
      }
    }
  } catch {}
}

export function getRouteLine() {
  if (!trackLayer) return null;
  const gj = trackLayer.toGeoJSON();
  if (gj.type === "FeatureCollection") {
    return (gj.features || []).find(f => f?.geometry?.type === "LineString" || f?.geometry?.type === "MultiLineString");
  }
  return gj;
}

export function drawCorridor(polyFeature) {
  corridorLayer.clearLayers();
  L.geoJSON(polyFeature, { style: { color: "#ff006e", weight: 2, fill: false }})
    .addTo(corridorLayer);
}

export function renderAllPoisGhosted(features) {
  if (allPoisLayer) { allPoisLayer.remove(); }
  const onlyGhost = (features || []).filter(f => !f?.properties?._forced);
  allPoisLayer = L.geoJSON({type:"FeatureCollection",features: onlyGhost}, {
    pointToLayer: (f, latlng) => L.marker(latlng, { icon: chooseIcon(f, true), opacity: 0.35 }),
    onEachFeature: (f, layer) => {
      layer.bindPopup(buildPoiPopup(f, f.properties?._distance_m || null, false, !f.properties?._inside));
      layer.on("popupopen", () => attachForceButtons(f));
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
      layer.bindPopup(buildPoiPopup(f, d, true, true));
      layer.on("popupopen", () => attachForceButtons(f));
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

function attachForceButtons(f) {
  const btn = document.querySelector(`.btn-inline[data-force-id="${esc(f.id)}"]`);
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (typeof window.toggleForcedExport === "function") {
      window.toggleForcedExport(f.id);
    }
  }, { once: true });
}

export function clearCustomPois() {
  try { customPoisLayer.clearLayers(); } catch {}
  _customPois = [];
  window.dispatchEvent(new CustomEvent("custom-pois-changed"));
}

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

  // Pass user-entered values so export uses them verbatim
  const tags = {
    name: label || "",
    _exportName: label || "",
    _exportDesc: desc || ""
  };

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
        <button class="btn-inline danger" data-id="${id}">Delete</button>
      </div>
    </div>
  `;

  m.bindPopup(html);
  m._custom_id = id;

  _customPois.push({ id, lat, lon, type: poiTypeId, label, desc, iconUrl, marker: m });
  window.dispatchEvent(new CustomEvent("custom-pois-changed"));

  m.on("popupopen", () => {
    const el = document.querySelector(`.btn-inline.danger[data-id="${id}"]`);
    if (el) el.addEventListener("click", () => {
      customPoisLayer.removeLayer(m);
      _customPois = _customPois.filter(p => p.id !== id);
      window.dispatchEvent(new CustomEvent("custom-pois-changed"));
    });
  });

  return { id, lat, lon, type: poiTypeId, label, desc, iconUrl };
}

export function listCustomPois() {
  return _customPois.map(({ marker, ...rest }) => ({ ...rest }));
}

function buildPoiPopup(feature, distanceM, includeGpxSnippet=false, allowForce=false) {
  const props = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [null, null];

  // Use exact type casing for export/GPX fields
  const exportType = (props?._type || props?.type || "generic").toString().trim();
  const { nameLabel, sym, desc } = buildExportFields(props, exportType, distanceM);

  const rows = [];
  if (props?.name)          rows.push(row("Name", String(props.name)));
  if (props?.operator)      rows.push(row("Operator", String(props.operator)));
  if (props?.opening_hours) rows.push(row("Hours", String(props.opening_hours)));
  if (distanceM != null)    rows.push(row("Distance", `${distanceM} m`));

  let gpxBlock = "";
  if (includeGpxSnippet && Number.isFinite(lat) && Number.isFinite(lon)) {
    const gpx = buildGpxSnippet(lat, lon, nameLabel, desc, sym);
    gpxBlock = `<div class="subhead">GPX</div><pre class="code">${esc(gpx)}</pre>`;
  }

  const action = allowForce
    ? `<div class="actions">
         <button class="btn-inline" data-force-id="${esc(feature.id)}">${props?._forced ? "Remove from export" : "Add to export"}</button>
       </div>`
    : "";

  return `<div class="popup">
    <div class="title">${maybeIconImg(props, exportType.toLowerCase())}<span>${esc(nameLabel)}</span></div>
    ${rows.length ? rows.join("") : ""}
    ${gpxBlock}
    ${action}
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
  return fallbackDivIcon(ghost ? "G" : (props._forced ? "★" : "P"), ghost);
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
export function getLayers(){ return { trackLayer, waypointLayer, allPoisLayer, poisLayer, distanceLayer, corridorLayer, searchPolyLayer, customPoisLayer }; }
