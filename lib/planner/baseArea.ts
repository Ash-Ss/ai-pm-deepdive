/**
 * Pick the hotel area for a leg: the area closest (score-weighted) to the
 * places we're most likely to visit. Day trips are ignored — you drive to
 * Ajanta from anywhere in the city.
 */
import type { City, StageResult } from "../types";
import { haversineKm } from "./geo";
import type { CandidatePool, HotelBase } from "./plannerTypes";
import { startTrace } from "./trace";

const TOP_N = 12;

export function chooseBaseArea(city: City, pool: CandidatePool, walkabilityMatters: boolean): StageResult<HotelBase> {
  const t = startTrace("chooseBaseArea", { cityId: city.id, areas: city.areas.map((a) => a.id) });
  const targets = pool.pois.filter((p) => !p.isDayTrip).slice(0, TOP_N);
  const scored = city.areas.map((area) => {
    // Weighted mean distance to the top places; higher-scored places pull harder.
    const wSum = targets.reduce((s, p) => s + Math.max(0.1, p.score), 0) || 1;
    const km = targets.reduce((s, p) => s + Math.max(0.1, p.score) * haversineKm(area, p.poi), 0) / wSum;
    // Walkable areas matter more when walking is limited (short hops stay short).
    const bonus = walkabilityMatters ? (area.walkability - 3) * 0.5 : 0;
    return { area, km: Math.round(km * 10) / 10, score: Math.round((km - bonus) * 10) / 10 };
  });
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  t.decide(`base in ${best.area.name}`, `lowest weighted distance to top ${targets.length} places`, scored.map((s) => `${s.area.id}: ${s.km}km (score ${s.score})`));
  return t.finish({ area: best.area, cityId: city.id }, { areaId: best.area.id });
}
