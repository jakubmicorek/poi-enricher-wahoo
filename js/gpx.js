// js/gpx.js
import { buildExportFields } from "./mapping.js";

/** NEW: strip all <wpt> from a GPX string (used when user chooses the option) */
export function stripWaypointsFromGpx(gpxXmlString) {
  if (!gpxXmlString) return "";
  const doc = new DOMParser().parseFromString(gpxXmlString, "text/xml");
  const gpx = doc.documentElement;
  const nodes = Array.from(gpx.getElementsByTagName("wpt"));
  nodes.forEach(n => gpx.removeChild(n));
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Adds POIs as <wpt> to a GPX doc.
 * Now with de-duplication against existing <wpt> (and within the batch).
 */
export function addPoisAsWaypointsToGpx(gpxXmlString, pois) {
  if (!gpxXmlString) return "";
  const doc = new DOMParser().parseFromString(gpxXmlString, "text/xml");
  const gpx = doc.documentElement;
  const ns  = gpx.namespaceURI || "http://www.topografix.com/GPX/1/1";

  // Collect existing waypoint signatures to avoid duplicates
  const existingSig = new Set();
  const textOf = (parent, tag) => {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? String(el.textContent || "").trim() : "";
  };
  const sig = (lat, lon, name, sym, desc) =>
    `${toFixed5(lat)}|${toFixed5(lon)}|${(sym||"").trim().toLowerCase()}|${(name||"").trim()}|${(desc||"").trim()}`;

  Array.from(gpx.getElementsByTagName("wpt")).forEach(w => {
    const lat = w.getAttribute("lat");
    const lon = w.getAttribute("lon");
    const name = textOf(w, "name");
    const sym = textOf(w, "sym") || textOf(w, "type");
    const desc = textOf(w, "desc");
    existingSig.add(sig(lat, lon, name, sym, desc));
  });

  // Insert before first of these, to keep waypoints near the top if present
  let firstChild = null;
  for (const tag of ["wpt","rte","trk"]) {
    const el = gpx.getElementsByTagName(tag)[0];
    if (el) { firstChild = el; break; }
  }

  const IND = "  ";
  const batchSig = new Set();

  function appendIndentedWpt(node, nameText, symText, descText) {
    // Skip if duplicate vs existing or within this batch
    const s = sig(node.getAttribute("lat"), node.getAttribute("lon"), nameText, symText, descText);
    if (existingSig.has(s) || batchSig.has(s)) return;
    batchSig.add(s);

    // Pretty insert
    gpx.insertBefore(doc.createTextNode("\n"), firstChild || null);

    const wpt = doc.createElementNS(ns, "wpt");
    for (const { name, value } of Array.from(node.attributes)) {
      wpt.setAttribute(name, value);
    }

    // Rebuild children with pretty indentation
    const kids = Array.from(node.childNodes).filter(n => !(n.nodeType === 3 && !n.nodeValue.trim()));
    wpt.appendChild(doc.createTextNode("\n" + IND));
    kids.forEach((k) => {
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

    appendIndentedWpt(wpt, nameLabel, sym, desc);
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
