// js/config.js
// Loads + validates the POI config JSON and offers convenience lookups.

export async function loadPoiConfig(url = "./config/poi-config.json") {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Config load failed: ${res.status}`);
  const cfg = await res.json();
  validatePoiConfig(cfg);
  return decoratePoiConfig(cfg);
}

function validatePoiConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.categories)) {
    throw new Error("Invalid config: missing categories");
  }
  for (const c of cfg.categories) {
    if (!c.id || !c.label || !Array.isArray(c.items)) {
      throw new Error(`Invalid category: ${c?.id || "(no id)"}`);
    }
    for (const it of c.items) {
      if (!it.id || !it.label || !Array.isArray(it.overpass)) {
        throw new Error(`Invalid item in ${c.id}: ${it?.id || "(no id)"}`);
      }
    }
  }
}

function decoratePoiConfig(cfg) {
  const idToItem = new Map();
  const idToCategory = new Map();
  for (const cat of cfg.categories) {
    // Sort items alphabetically by label for the UI
    cat.items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    for (const it of cat.items) {
      idToItem.set(it.id, it);
      idToCategory.set(it.id, cat);
    }
  }
  return { ...cfg, idToItem, idToCategory };
}
