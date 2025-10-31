import { sleep } from "./util.js";

export const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter"
];

export function buildOverpassQueryFromConfigPoly(polyFeature, selectedItems, timeout = 90) {
  const rings = ringsFromFeature(polyFeature);

  const blocks = [];
  for (const it of (selectedItems || [])) {
    if (it.fetch === false) continue;
    const ors = Array.isArray(it.tags) ? it.tags : [];
    const ands = Array.isArray(it.tagsAll) ? it.tagsAll : [];

    for (const ring of rings) {
      const polyStr = coordsToPolyString(ring);
      for (const def of ors) {
        const k = def.k, v = def.v;
        if (!k || !v) continue;
        blocks.push(`node["${k}"="${v}"](poly:"${polyStr}");`);
        blocks.push(`way["${k}"="${v}"](poly:"${polyStr}");`);
        blocks.push(`relation["${k}"="${v}"](poly:"${polyStr}");`);
      }
      if (ands.length) {
        const sel = ands.map(d => `["${d.k}"="${d.v}"]`).join("");
        blocks.push(`node${sel}(poly:"${polyStr}");`);
        blocks.push(`way${sel}(poly:"${polyStr}");`);
        blocks.push(`relation${sel}(poly:"${polyStr}");`);
      }
    }
  }

  if (!blocks.length) {
    return `[out:json][timeout:${timeout}];node(0,0,0,0);out body;`;
  }

  return `[out:json][timeout:${timeout}];
(
${blocks.join("\n")}
);
out body center;`;
}

function ringsFromFeature(feature) {
  if (!feature) return [];
  const geom = feature.type === "Feature" ? feature.geometry : feature;
  if (!geom) return [];
  const t = geom.type;
  const c = geom.coordinates;

  if (t === "Polygon") {
    const outer = Array.isArray(c?.[0]) ? c[0] : [];
    return outer.length ? [ensureClosed(outer)] : [];
  }
  if (t === "MultiPolygon") {
    const rings = [];
    (c || []).forEach(poly => {
      const outer = Array.isArray(poly?.[0]) ? poly[0] : [];
      if (outer.length) rings.push(ensureClosed(outer));
    });
    return rings;
  }
  return [];
}

function ensureClosed(ring) {
  if (!ring.length) return ring;
  const [a0, a1] = ring[0];
  const [b0, b1] = ring[ring.length - 1];
  if (a0 !== b0 || a1 !== b1) return ring.concat([[a0, a1]]);
  return ring;
}

function coordsToPolyString(ring) {
  return ring.map(([lon, lat]) => `${Number(lat).toFixed(6)} ${Number(lon).toFixed(6)}`).join(" ");
}

export async function overpassFetch(queryQL) {
  let lastErr = "";
  const body = new URLSearchParams({ data: queryQL }).toString();

  for (const base of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const canAbort = typeof AbortController !== "undefined";
        const controller = canAbort ? new AbortController() : null;
        const t = canAbort ? setTimeout(() => controller.abort(), 90000) : null;

        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body,
          signal: controller?.signal
        });

        if (t) clearTimeout(t);
        if (res.ok) return await res.json();
        lastErr = `HTTP ${res.status}`;
        await sleep(400 * (attempt + 1));
      } catch (e) { lastErr = e?.message || String(e); await sleep(400); }
    }
  }
  throw new Error(lastErr || "All Overpass endpoints failed");
}

export function cacheKeyForRoute() { return `ovp:poly|v=cfg2`; }
export function savePoisCache(key, data) { try { localStorage.setItem(key, JSON.stringify({ts: Date.now(), data})); } catch {} }
export function loadPoisCache(key, maxAgeMs = 24*3600*1000) {
  try {
    const raw = localStorage.getItem(key); if (!raw) return null;
    const obj = JSON.parse(raw); if (Date.now() - obj.ts > maxAgeMs) return null;
    return obj.data;
  } catch { return null; }
}
