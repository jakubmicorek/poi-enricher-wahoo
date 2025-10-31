export function exportDisplayNameFromTags(tags = {}) {
  const a = (tags.amenity || "").toLowerCase();
  const s = (tags.shop || "").toLowerCase();
  const t = (tags.tourism || "").toLowerCase();
  const n = (tags.natural || "").toLowerCase();
  const l = (tags.leisure || "").toLowerCase();
  const r = (tags.railway || "").toLowerCase();
  const pt = (tags.public_transport || "").toLowerCase();
  const hw = (tags.highway || "").toLowerCase();
  const cr = (tags.craft || "").toLowerCase();

  if (a === "drinking_water") return "Water";
  if (a === "toilets") return "Toilet";
  if (a === "cafe") return "Coffee";
  if (a === "restaurant") return "Restaurant";
  if (a === "fast_food") return "Fast Food";
  if (s === "bakery") return "Bakery";
  if (s === "supermarket") return "Supermarket";
  if (s === "convenience") return "Convenience Store";
  if (a === "bar") return "Bar";
  if (a === "pub") return "Pub";
  if (a === "fuel") return "Gas Station";
  if (a === "pharmacy") return "Pharmacy";
  if (a === "hospital") return "Hospital";
  if (a === "library") return "Library";
  if (t === "information") return "Information";
  if (a === "ferry_terminal") return "Ferry Terminal";
  if (a === "parking") return "Parking";
  if (a === "bus_station") return "Bus Station";
  if (r === "station" || pt === "station") return "Station";
  if (a === "shower") return "Shower";
  if (s === "bicycle") return "Bicycle Shop";
  if (a === "bicycle_repair_station") return "Bicycle Repair Station";
  if (a === "bicycle_parking") return "Bike Parking";
  if (a === "bicycle_rental") return "Bike Share";
  if (t === "camp_site") return "Campsite";
  if (l === "park") return "Park";
  if (hw === "rest_area") return "Rest Area";
  if (a === "shelter") return "Shelter";
  if (t === "trailhead") return "Trailhead";
  if (t === "viewpoint") return "Viewpoint";
  if (n === "peak") return "Summit";
  if (n === "valley") return "Valley";
  if (l === "dog_park") return "Dog Park";
  if (t === "attraction") return "Attraction";
  if (t === "artwork") return "Artwork";
  if ((tags.historic || "").toLowerCase() === "monument") return "Monument";
  if (s === "wine") return "Wine Shop";
  if (cr === "winery") return "Winery";
  if (s === "mall") return "Shopping Mall";
  if (s === "department_store") return "Department Store";
  if (a === "atm") return "ATM";
  return "POI";
}

export function friendlyFromType(id) {
  if (!id) return "POI";
  return String(id).replace(/[_-]+/g, " ").trim().replace(/\s+/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase());
}

export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return null;
  const mm = Math.round(m);
  if (mm >= 1000) return `${(mm / 1000).toFixed(mm >= 10000 ? 0 : 1)} km`;
  return `${mm} m`;
}

export function prettyOpeningHours(oh) {
  const m = /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/.exec(oh);
  if (m) return `${m[1]} – ${m[2]}`;
  return String(oh);
}

export function buildExportFields(tags = {}, poiTypeId = "generic", distanceM = null) {
  const sym = (poiTypeId || tags._type || tags.type || "generic").toString().trim().toLowerCase();
  let nameLabel = exportDisplayNameFromTags(tags);
  if (!nameLabel || nameLabel.toLowerCase() === "poi") nameLabel = friendlyFromType(sym);
  const poiName = (tags.name && String(tags.name).trim()) || "";
  const dist = formatDistance(distanceM);
  const hours = tags.opening_hours ? prettyOpeningHours(tags.opening_hours) : null;
  const parts = [sym, poiName || null, dist, hours].filter(Boolean);
  const desc = parts.join(" | ");
  return { nameLabel, sym, desc };
}
