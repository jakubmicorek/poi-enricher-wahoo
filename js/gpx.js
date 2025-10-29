// js/gpx.js
import { buildExportFields } from "./mapping.js";

/**
 * Adds POIs as <wpt> to a GPX doc.
 * Pretty-prints each waypoint:
 *
 * <wpt lat=".." lon="..">
 *   <name>Water</name>
 *   <desc>water | Fountain | 26 m</desc>
 *   <sym>water</sym>
 *   <type>water</type>
 * </wpt>
 *
 * No metadata renaming here — route/document name is preserved as-is.
 */
export function addPoisAsWaypointsToGpx(gpxXmlString, pois) {
  if (!gpxXmlString) return "";
  const doc = new DOMParser().parseFromString(gpxXmlString, "text/xml");
  const gpx = doc.documentElement;
  const ns  = gpx.namespaceURI || "http://www.topografix.com/GPX/1/1";

  // Insert before first of these, to keep waypoints near the top if present
  let firstChild = null;
  for (const tag of ["wpt","rte","trk"]) {
    const el = gpx.getElementsByTagName(tag)[0];
    if (el) { firstChild = el; break; }
  }

  const IND = "  ";

  function appendIndentedWpt(node) {
    // Insert a newline before the waypoint
    gpx.insertBefore(doc.createTextNode("\n"), firstChild || null);

    // Rebuild with pretty indentation
    const wpt = doc.createElementNS(ns, "wpt");
    for (const { name, value } of Array.from(node.attributes)) {
      wpt.setAttribute(name, value);
    }

    const kids = Array.from(node.childNodes).filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()));
    wpt.appendChild(doc.createTextNode("\n" + IND));
    kids.forEach((k, i) => {
      wpt.appendChild(k);
      wpt.appendChild(doc.createTextNode("\n" + IND));
    });
    if (wpt.lastChild?.nodeType === 3) wpt.removeChild(wpt.lastChild);
    wpt.appendChild(doc.createTextNode("\n"));

    if (firstChild) gpx.insertBefore(wpt, firstChild); else gpx.appendChild(wpt);
  }

  (pois || []).forEach(p => {
    const tags = p.tags || {};
    const wahooId = (p._type || tags._type || tags.type || "generic").toString().trim().toLowerCase();
    const dist = p._distance_m ?? null;

    const { nameLabel, sym, desc } = buildExportFields(tags, wahooId, dist);

    const wpt = doc.createElementNS(ns, "wpt");
    wpt.setAttribute("lat", toFixed5(p.lat));
    wpt.setAttribute("lon", toFixed5(p.lon));

    const nameEl = doc.createElementNS(ns, "name"); nameEl.textContent = nameLabel; wpt.appendChild(nameEl);
    const descEl = doc.createElementNS(ns, "desc"); descEl.textContent = desc;     wpt.appendChild(descEl);
    const symEl  = doc.createElementNS(ns, "sym");  symEl.textContent  = sym;      wpt.appendChild(symEl);
    const typeEl = doc.createElementNS(ns, "type"); typeEl.textContent = sym;      wpt.appendChild(typeEl);

    appendIndentedWpt(wpt);
  });

  // Cosmetic: trailing newline
  gpx.appendChild(doc.createTextNode("\n"));
  return new XMLSerializer().serializeToString(doc);
}

/* ---------- helpers ---------- */
function toFixed5(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(5) : String(n);
}
