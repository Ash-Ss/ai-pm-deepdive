/**
 * Distance and local travel-time estimates. Deliberately simple and explainable:
 * straight-line distance × a detour factor ÷ a typical speed.
 */
import type { Levers } from "../types";

export type LatLng = { lat: number; lng: number };
export type LocalMode = "walk" | "auto_taxi";
export type LocalLeg = { mode: LocalMode; minutes: number; km: number };

const ROAD_FACTOR = 1.4; // roads aren't straight lines
const WALK_FACTOR = 1.2; // pavements are straighter than roads, but not straight
const WALK_KMH = 4.5;
const TAXI_OVERHEAD_MIN = 5; // hailing / parking
const MIN_TAXI_MIN = 10;
const FORCED_TAXI_WALK_MAX_MIN = 4;

/** Average door-to-door taxi speeds inside each city (traffic-heavy metros are slower). */
const CITY_KMH: Record<string, number> = { mumbai: 18, pune: 22 };
const DEFAULT_CITY_KMH = 30;
/**
 * Beyond this many road-km a trip is out on the highway (day trips like Ajanta),
 * where city speeds would badly overstate the time.
 */
const HIGHWAY_AFTER_KM = 20;
const HIGHWAY_KMH = 45;

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function taxiMinutes(straightKm: number, cityId: string): { minutes: number; roadKm: number } {
  const roadKm = straightKm * ROAD_FACTOR;
  const cityKm = Math.min(roadKm, HIGHWAY_AFTER_KM);
  const highwayKm = Math.max(0, roadKm - HIGHWAY_AFTER_KM);
  const drive = (cityKm / (CITY_KMH[cityId] ?? DEFAULT_CITY_KMH) + highwayKm / HIGHWAY_KMH) * 60;
  return { minutes: Math.max(MIN_TAXI_MIN, Math.round(drive + TAXI_OVERHEAD_MIN)), roadKm };
}

export function walkMinutes(straightKm: number): { minutes: number; walkKm: number } {
  const walkKm = straightKm * WALK_FACTOR;
  return { minutes: Math.round((walkKm / WALK_KMH) * 60), walkKm };
}

/**
 * Walk when it's short and the destination is flat; otherwise take an auto/taxi.
 * `forceTaxi` is used by the repair step to cut walking on over-budget days.
 */
export function localLeg(
  from: LatLng,
  to: LatLng,
  cityId: string,
  levers: Pick<Levers, "preferTaxiAboveWalkMin">,
  opts: { flatTerrain: boolean; forceTaxi?: boolean },
): LocalLeg {
  const km = haversineKm(from, to);
  if (km < 0.05) return { mode: "walk", minutes: 0, km: 0 };
  const walk = walkMinutes(km);
  // forceTaxi still lets you walk next door — nobody takes a taxi for 200 m.
  const walkLimit = opts.forceTaxi ? Math.min(FORCED_TAXI_WALK_MAX_MIN, levers.preferTaxiAboveWalkMin) : levers.preferTaxiAboveWalkMin;
  if (opts.flatTerrain && walk.minutes <= walkLimit) {
    return { mode: "walk", minutes: walk.minutes, km: round1(walk.walkKm) };
  }
  const taxi = taxiMinutes(km, cityId);
  return { mode: "auto_taxi", minutes: taxi.minutes, km: round1(taxi.roadKm) };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Beyond this distance from the hotel a day trip takes the whole day (Ajanta yes, Ellora no). */
export const FAR_DAY_TRIP_KM = 60;

export function isFarDayTrip(poi: LatLng & { isDayTripFrom: string | null }, hotel: LatLng): boolean {
  return poi.isDayTripFrom !== null && haversineKm(hotel, poi) > FAR_DAY_TRIP_KM;
}
