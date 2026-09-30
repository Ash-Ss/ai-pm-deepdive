/**
 * Validates the catalogue in /data. Run: npm run validate:data
 *
 * Schema checks catch shape errors; the cross-file checks below catch the
 * mistakes zod can't see (dangling IDs, impossible hours, typo'd coordinates).
 * Exits non-zero on any error so it can gate CI later.
 */
import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";
import { City, CityEdge, Event, Experience, Poi, Restaurant } from "../lib/types";

const DATA_DIR = path.join(__dirname, "..", "data");

// Generous bounding box for Maharashtra (state spans ~15.6–22.1 N, ~72.6–80.9 E).
const MH_BOUNDS = { minLat: 15.6, maxLat: 22.1, minLng: 72.6, maxLng: 80.9 };
const MIN_POIS_PER_CITY = 8;
const MIN_MUST_SEE_PER_CITY = 3;

const errors: string[] = [];
const warnings: string[] = [];
const err = (msg: string) => errors.push(msg);
const warn = (msg: string) => warnings.push(msg);

function load<T extends z.ZodType>(file: string, schema: T): z.infer<T>[] {
  const raw = JSON.parse(readFileSync(path.join(DATA_DIR, file), "utf8"));
  const result = z.array(schema).safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) err(`${file}: ${issue.path.join(".")} — ${issue.message}`);
    return [];
  }
  return result.data;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function checkUnique(label: string, ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) err(`${label}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function checkCoords(label: string, lat: number, lng: number) {
  const b = MH_BOUNDS;
  if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) {
    err(`${label}: coordinates (${lat}, ${lng}) outside Maharashtra bounds`);
  }
}

function checkOpeningHours(p: Poi) {
  for (const [day, ranges] of Object.entries(p.openingHours)) {
    // Ranges must be increasing and non-overlapping; overnight ranges aren't supported.
    let prevClose = -1;
    for (const [open, close] of ranges) {
      if (toMin(open) >= toMin(close)) err(`poi ${p.id}: ${day} range ${open}–${close} closes before it opens`);
      if (toMin(open) < prevClose) err(`poi ${p.id}: ${day} ranges overlap or are out of order`);
      prevClose = toMin(close);
    }
    const isOff = p.weeklyOff.includes(day as Poi["weeklyOff"][number]);
    if (isOff && ranges.length > 0) err(`poi ${p.id}: ${day} is a weekly off but has opening hours`);
    if (!isOff && ranges.length === 0) err(`poi ${p.id}: ${day} has no hours but isn't listed in weeklyOff`);
  }
  // The typical visit should fit inside the longest opening window of some day.
  const longest = Math.max(
    0,
    ...Object.values(p.openingHours).flatMap((rs) => rs.map(([o, c]) => toMin(c) - toMin(o))),
  );
  if (p.durationMin.typical > longest) err(`poi ${p.id}: typical duration ${p.durationMin.typical}min exceeds longest opening window ${longest}min`);
}

// ---------------------------------------------------------------------------

const cities = load("cities.json", City);
const pois = load("pois.json", Poi);
const restaurants = load("restaurants.json", Restaurant);
const experiences = load("experiences.json", Experience);
const edges = load("edges.json", CityEdge);
const events = load("events.json", Event);

// IDs unique within each collection, and areas unique across all cities
// (so an areaId alone is unambiguous).
checkUnique("cities", cities.map((c) => c.id));
checkUnique("areas", cities.flatMap((c) => c.areas.map((a) => a.id)));
checkUnique("pois", pois.map((p) => p.id));
checkUnique("restaurants", restaurants.map((r) => r.id));
checkUnique("experiences", experiences.map((e) => e.id));
checkUnique("events", events.map((e) => e.id));
// Also unique across POIs/restaurants/experiences, since Item.refId can point at any of them.
checkUnique("catalogue refIds", [...pois, ...restaurants, ...experiences].map((x) => x.id));

const cityById = new Map(cities.map((c) => [c.id, c]));
const poiById = new Map(pois.map((p) => [p.id, p]));
const areaCity = new Map(cities.flatMap((c) => c.areas.map((a) => [a.id, c.id] as const)));

function checkCityArea(label: string, cityId: string, areaId?: string) {
  if (!cityById.has(cityId)) return err(`${label}: unknown cityId "${cityId}"`);
  if (areaId === undefined) return;
  const owner = areaCity.get(areaId);
  if (!owner) err(`${label}: unknown areaId "${areaId}"`);
  else if (owner !== cityId) err(`${label}: area "${areaId}" belongs to ${owner}, not ${cityId}`);
}

for (const c of cities) {
  checkCoords(`city ${c.id}`, c.lat, c.lng);
  for (const a of c.areas) checkCoords(`area ${a.id}`, a.lat, a.lng);
  if (c.minNights > c.saturationNights) err(`city ${c.id}: minNights > saturationNights`);
}

for (const p of pois) {
  checkCityArea(`poi ${p.id}`, p.cityId, p.areaId);
  checkCoords(`poi ${p.id}`, p.lat, p.lng);
  checkOpeningHours(p);
  if (p.isDayTripFrom && !cityById.has(p.isDayTripFrom)) err(`poi ${p.id}: unknown isDayTripFrom "${p.isDayTripFrom}"`);
  if (p.tier === "must_see" && p.needsVerification !== true) err(`poi ${p.id}: must_see without needsVerification`);
  for (const w of p.avoidTimes) if (toMin(w.start) >= toMin(w.end)) err(`poi ${p.id}: avoidTimes ${w.start}–${w.end} invalid`);
}

for (const r of restaurants) {
  checkCityArea(`restaurant ${r.id}`, r.cityId, r.areaId);
  checkCoords(`restaurant ${r.id}`, r.lat, r.lng);
  if (!r.dietary.veg && !r.dietary.nonVeg) err(`restaurant ${r.id}: serves neither veg nor non-veg`);
  if (r.dietary.jain && !r.dietary.veg) err(`restaurant ${r.id}: jain but not veg`);
}

for (const x of experiences) {
  checkCityArea(`experience ${x.id}`, x.cityId);
  for (const pid of x.linkedPoiIds) {
    const p = poiById.get(pid);
    if (!p) err(`experience ${x.id}: unknown linkedPoiId "${pid}"`);
    else if (p.cityId !== x.cityId) warn(`experience ${x.id}: linked POI ${pid} is in ${p.cityId}`);
  }
}

const edgeKeys = new Set<string>();
for (const e of edges) {
  checkCityArea(`edge ${e.fromCityId}->${e.toCityId}`, e.fromCityId);
  checkCityArea(`edge ${e.fromCityId}->${e.toCityId}`, e.toCityId);
  if (e.fromCityId === e.toCityId) err(`edge ${e.fromCityId}: self-loop`);
  // Edges are undirected, so A->B and B->A with the same mode are duplicates.
  const key = [e.fromCityId, e.toCityId].sort().join("|") + "|" + e.mode;
  if (edgeKeys.has(key)) err(`edge ${key}: duplicate (edges are undirected)`);
  edgeKeys.add(key);
}
// Every pair of cities should be reachable directly, or the planner can't order them.
for (const a of cities) for (const b of cities) {
  if (a.id < b.id && ![...edgeKeys].some((k) => k.startsWith(`${a.id}|${b.id}|`))) {
    warn(`no edge between ${a.id} and ${b.id}`);
  }
}

for (const ev of events) {
  checkCityArea(`event ${ev.id}`, ev.cityId);
  if (ev.startDate > ev.endDate) err(`event ${ev.id}: startDate after endDate`);
  for (const pid of ev.impact.affectedPoiIds) if (!poiById.has(pid)) err(`event ${ev.id}: unknown affectedPoiId "${pid}"`);
}

// Coverage: every city needs enough material to fill days.
for (const c of cities) {
  const cityPois = pois.filter((p) => p.cityId === c.id);
  const mustSee = cityPois.filter((p) => p.tier === "must_see").length;
  if (cityPois.length < MIN_POIS_PER_CITY) err(`city ${c.id}: only ${cityPois.length} POIs (need ≥ ${MIN_POIS_PER_CITY})`);
  if (mustSee < MIN_MUST_SEE_PER_CITY) err(`city ${c.id}: only ${mustSee} must_see POIs (need ≥ ${MIN_MUST_SEE_PER_CITY})`);
  if (!restaurants.some((r) => r.cityId === c.id)) err(`city ${c.id}: no restaurants`);
}

// ---------------------------------------------------------------------------

console.log("Catalogue summary");
for (const c of cities) {
  const cp = pois.filter((p) => p.cityId === c.id);
  console.log(
    `  ${c.id.padEnd(14)} areas ${c.areas.length}  pois ${String(cp.length).padStart(2)}  must_see ${cp.filter((p) => p.tier === "must_see").length}  ` +
      `restaurants ${restaurants.filter((r) => r.cityId === c.id).length}  experiences ${experiences.filter((x) => x.cityId === c.id).length}`,
  );
}
console.log(`  totals: pois ${pois.length}, restaurants ${restaurants.length}, experiences ${experiences.length}, edges ${edges.length}, events ${events.length}`);

for (const w of warnings) console.warn(`WARN  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\n${errors.length} error(s)`);
  process.exit(1);
}
console.log("\n✓ data valid");
