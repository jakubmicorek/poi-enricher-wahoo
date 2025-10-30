// js/overpass.js
import { sleep } from "./util.js";

export const FETCH_BBOX_RADIUS_M = 500;
export const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter"
];

// Build an Overpass QL query from selected POI items (config-driven)
// Supports either `overpass: [{k,v}]` or `tags: [{k,v}]` in the config.
export function buildOverpassQueryFromConfig(bbox, selectedItems, timeout = 90) {
  const [minX, minY, maxX, maxY] = bbox;
  const bboxStr = `(${minY},${minX},${maxY},${maxX})`;

  const parts = [];
  for (const it of selectedItems) {
    if (it.fetch === false) continue;
    const defs = Array.isArray(it.overpass) ? it.overpass : (Array.isArray(it.tags) ? it.tags : []);
    for (const def of defs) {
      const k = def.k, v = def.v;
      if (!k || !v) continue;
      parts.push(`node["${k}"="${v}"]${bboxStr};`);
      parts.push(`way["${k}"="${v}"]${bboxStr};`);
      // If needed later:
      // parts.push(`relation["${k}"="${v}"]${bboxStr};`);
    }
  }

  if (!parts.length) {
    // empty harmless query that returns nothing but is valid
    return `[out:json][timeout:${timeout}];node(0,0,0,0);out body;`;
  }

  return `[out:json][timeout:${timeout}];
(
${parts.join("\n")}
);
out body center;`;
}

export async function overpassFetch(queryQL) {
  let lastErr = "";
  const body = new URLSearchParams({ data: queryQL }).toString();

  for (const base of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Some mobile webviews lack AbortController; also avoid forbidden headers like User-Agent
        const canAbort = typeof AbortController !== "undefined";
        const controller = canAbort ? new AbortController() : null;
        const t = canAbort ? setTimeout(() => controller.abort(), 90000) : null;

        const res = await fetch(base, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
          },
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

export function cacheKeyForRoute(bbox, gpxText, catsKey) {
  const bboxKey = bbox.map(n => Number(n).toFixed(6)).join(",");
  const hash = fastHash((gpxText || "").slice(0, 20000));
  return `ovp:bbox=${bboxKey}|cats=${catsKey}|g=${hash}|v=cfg1`;
}

function fastHash(s){
  let h = 2166136261 >>> 0;
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

export function savePoisCache(key, data) { try { localStorage.setItem(key, JSON.stringify({ts: Date.now(), data})); } catch {} }
export function loadPoisCache(key, maxAgeMs = 24*3600*1000) {
  try {
    const raw = localStorage.getItem(key); if (!raw) return null;
    const obj = JSON.parse(raw); if (Date.now() - obj.ts > maxAgeMs) return null;
    return obj.data;
  } catch { return null; }
}
