/**
 * Stage 2 — decide which cities are bases and in what order to visit them.
 *
 * With ≤ 5 bases there are at most 120 orderings, so we simply score them all:
 * exhaustive search is easier to explain than a heuristic and fast enough.
 */
import type { City, CityEdge, Constraint, Levers, Poi, StageResult } from "../types";
import { ofType } from "./constraints";
import { haversineKm } from "./geo";
import { startTrace } from "./trace";

// ---------------------------------------------------------------------------
// Classification: bases vs day trips
// ---------------------------------------------------------------------------

export type PlaceClassification = {
  bases: string[];
  /** Day-trip POIs the user named; they become must-includes at their base. */
  dayTrips: { poiId: string; fromCityId: string }[];
  unknown: string[];
};

export function classifyPlaces(placeIds: string[], cities: City[], pois: Poi[]): StageResult<PlaceClassification> {
  const t = startTrace("classifyPlaces", { placeIds });
  const out: PlaceClassification = { bases: [], dayTrips: [], unknown: [] };
  const addBase = (id: string) => { if (!out.bases.includes(id)) out.bases.push(id); };

  for (const id of placeIds) {
    const poi = pois.find((p) => p.id === id);
    if (poi?.isDayTripFrom) {
      out.dayTrips.push({ poiId: id, fromCityId: poi.isDayTripFrom });
      addBase(poi.isDayTripFrom);
      t.decide(`${id} → day trip from ${poi.isDayTripFrom}`, "POI has isDayTripFrom set, so it is visited from a base, not slept at");
    } else if (cities.some((c) => c.id === id)) {
      addBase(id);
    } else {
      out.unknown.push(id);
      t.decide(`ignored ${id}`, "not a city or day-trip POI in the catalogue");
    }
  }
  return t.finish(out, out);
}

// ---------------------------------------------------------------------------
// Route ordering
// ---------------------------------------------------------------------------

export type Hop = { from: string; to: string; edge: CityEdge; minutes: number; alternatives: string[] };
export type RouteBreakdown = {
  transitHours: number;
  backtrackPenalty: number;
  fatiguePenalty: number;
  softViolationPenalty: number;
  hardViolations: string[];
};
export type RouteOption = { order: string[]; hops: Hop[]; score: number; breakdown: RouteBreakdown };
export type RouteResult = { best: RouteOption; ranked: RouteOption[] };

/** Fastest edge between two cities (edges are undirected), oriented a → b. */
export function bestEdge(a: string, b: string, edges: CityEdge[]): { edge: CityEdge; alternatives: string[] } | null {
  const matches = edges
    .filter((e) => (e.fromCityId === a && e.toCityId === b) || (e.fromCityId === b && e.toCityId === a))
    .sort((x, y) => x.doorToDoorMin - y.doorToDoorMin || y.comfort - x.comfort);
  if (matches.length === 0) return null;
  const e = matches[0];
  return {
    edge: { ...e, fromCityId: a, toCityId: b },
    alternatives: matches.slice(1).map((m) => `${m.mode} ${m.doorToDoorMin}min`),
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const FATIGUE_THRESHOLD_MIN = 180; // a transfer longer than this straight after arrival is tiring
const BACKTRACK_WEIGHT = 0.5; // hours of penalty per hour of detour
const DETOUR_KMH = 50;
const SOFT_ORDER_PENALTY_H = 2;

/** True if `order` keeps `required` in the same relative order. */
function respectsOrder(order: string[], required: string[]): boolean {
  const idx = required.map((c) => order.indexOf(c)).filter((i) => i >= 0);
  return idx.every((v, i) => i === 0 || v > idx[i - 1]);
}

export function routeOrder(args: {
  cityIds: string[];
  entryCityId?: string | null;
  exitCityId?: string | null;
  edges: CityEdge[];
  cities: City[];
  constraints: Constraint[];
  levers: Levers;
}): StageResult<RouteResult> {
  const { cityIds, entryCityId, exitCityId, edges, cities, constraints, levers } = args;
  const t = startTrace("routeOrder", { cityIds, entryCityId, exitCityId, maxTransitMinPerDay: levers.maxTransitMinPerDay });
  const cityById = new Map(cities.map((c) => [c.id, c]));
  const orderConstraints = ofType(constraints, "city_order");
  const hardLimit = levers.maxTransitMinPerDay * 1.5;

  const candidates = permutations(cityIds).filter((order) => {
    // A named entry/exit that is also a base is pinned to the start/end.
    if (entryCityId && cityIds.includes(entryCityId) && order[0] !== entryCityId) return false;
    if (exitCityId && exitCityId !== entryCityId && cityIds.includes(exitCityId) && order.at(-1) !== exitCityId) return false;
    return true;
  });
  t.decide(`${candidates.length} orderings to score`, "all permutations of bases, with entry/exit pinned");

  const ranked: RouteOption[] = candidates.map((order) => {
    const hardViolations: string[] = [];
    // Full path including arrival and departure hops that don't involve a stay.
    const path = [...order];
    if (entryCityId && path[0] !== entryCityId) path.unshift(entryCityId);
    if (exitCityId && path.at(-1) !== exitCityId) path.push(exitCityId);

    const hops: Hop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const found = bestEdge(path[i], path[i + 1], edges);
      if (!found) {
        hardViolations.push(`no connection ${path[i]} → ${path[i + 1]}`);
        continue;
      }
      hops.push({ from: path[i], to: path[i + 1], edge: found.edge, minutes: found.edge.doorToDoorMin, alternatives: found.alternatives });
      if (found.edge.doorToDoorMin > hardLimit) {
        hardViolations.push(`${path[i]} → ${path[i + 1]} takes ${found.edge.doorToDoorMin}min (> 1.5 × max ${levers.maxTransitMinPerDay}min/day)`);
      }
    }

    const transitHours = hops.reduce((s, h) => s + h.minutes, 0) / 60;

    // Backtracking: A → B → C where C is closer to A than B was means we went out and came back.
    let backtrackPenalty = 0;
    for (let i = 0; i + 2 < path.length; i++) {
      const [a, b, c] = [cityById.get(path[i]), cityById.get(path[i + 1]), cityById.get(path[i + 2])];
      if (!a || !b || !c) continue;
      const ab = haversineKm(a, b), bc = haversineKm(b, c), ac = haversineKm(a, c);
      if (ac < ab) backtrackPenalty += (BACKTRACK_WEIGHT * (ab + bc - ac)) / DETOUR_KMH;
    }

    // Fatigue: a long transfer straight off the plane/train.
    const firstHop = hops[0];
    const fatiguePenalty =
      entryCityId && firstHop && firstHop.from === entryCityId && firstHop.to !== entryCityId && firstHop.minutes > FATIGUE_THRESHOLD_MIN
        ? (firstHop.minutes - FATIGUE_THRESHOLD_MIN) / 60
        : 0;

    let softViolationPenalty = 0;
    for (const c of orderConstraints) {
      if (respectsOrder(order, c.params.cityIds)) continue;
      if (c.strength === "hard") hardViolations.push(`violates city_order ${c.params.cityIds.join(" → ")}`);
      else softViolationPenalty += SOFT_ORDER_PENALTY_H;
    }

    const score = hardViolations.length
      ? Infinity
      : round2(transitHours + backtrackPenalty + fatiguePenalty + softViolationPenalty);
    return {
      order,
      hops,
      score,
      breakdown: {
        transitHours: round2(transitHours),
        backtrackPenalty: round2(backtrackPenalty),
        fatiguePenalty: round2(fatiguePenalty),
        softViolationPenalty,
        hardViolations,
      },
    };
  });

  ranked.sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (best.score === Infinity) {
    t.decide("no feasible route", "every ordering breaks a hard constraint; using the least-bad one", best.breakdown.hardViolations);
  } else {
    t.decide(`picked ${best.order.join(" → ")}`, `lowest score ${best.score}h`, best.breakdown);
  }
  for (const h of best.hops) {
    t.decide(`${h.from} → ${h.to} by ${h.edge.mode} (${h.minutes}min)`, "fastest door-to-door option", { alternatives: h.alternatives });
  }

  return t.finish({ best, ranked }, {
    ranked: ranked.slice(0, 5).map((r) => ({ order: r.order.join(" → "), score: r.score, ...r.breakdown })),
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
