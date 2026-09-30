/**
 * Stage 3 — split the trip's nights across the ordered bases.
 *
 * demand(city) = hours of worthwhile sightseeing there ÷ usable hours per day.
 * Nights are then handed out one at a time to the city with the largest unmet
 * demand (a largest-remainder style proportional split that stays within
 * min/max bounds and always sums exactly to totalNights).
 */
import type { City, Constraint, Levers, Poi, StageResult } from "../types";
import { interestTags, ofType } from "./constraints";
import { accessibleVersion, hardFilterFailure, mobilityRules, priceCapPerPerson } from "./candidatePool";
import { haversineKm, isFarDayTrip, taxiMinutes } from "./geo";
import type { LegAlloc, PlannerContext } from "./plannerTypes";
import type { RouteOption } from "./routeOrder";
import { addDays, toMin } from "./time";
import { startTrace } from "./trace";

const ARRIVAL_FACTOR = 0.5; // trip arrival day
const DEPARTURE_FACTOR = 0.5; // trip departure day
const TRAVEL_DAY_FACTOR = 0.6; // day spent partly on an intercity transfer (loses ~40%)
const OVERLOAD_THRESHOLD = 1.3;
const LUNCH_MIN = 60;
const DINNER_MIN = 60;

/** Sightseeing minutes in a normal full day after meals, free time and buffers. */
export function usableActivityMin(levers: Levers): number {
  const span = toMin(levers.dayEnd) - toMin(levers.dayStart);
  const dinnerInside = toMin(levers.dinnerWindow.start) < toMin(levers.dayEnd) ? DINNER_MIN : 0;
  return Math.max(60, Math.round((span - LUNCH_MIN - dinnerInside - levers.freeTimeMin) * (1 - levers.bufferPct)));
}

/** Day-equivalents a leg offers, given its position in the route. */
function legCapacity(nights: number, isFirst: boolean, isLast: boolean): number {
  const days = nights + (isLast ? 1 : 0);
  if (days === 0) return 0;
  const factors = Array.from({ length: days }, () => 1);
  factors[0] = isFirst ? ARRIVAL_FACTOR : TRAVEL_DAY_FACTOR;
  if (isLast) factors[days - 1] = Math.min(factors[days - 1], DEPARTURE_FACTOR);
  return factors.reduce((a, b) => a + b, 0);
}

export function allocateNights(args: {
  route: RouteOption;
  totalNights: number;
  startDate: string;
  pois: Poi[];
  cities: City[];
  levers: Levers;
  constraints: Constraint[];
  ctx: PlannerContext;
  /** Where the trip starts (arrival city), if known. */
  entryCityId?: string | null;
}): StageResult<{
  legs: LegAlloc[];
  demandDays: Record<string, number>;
  /** Same measure without hard filters, to show what filtering removed. */
  demandBeforeFilters: Record<string, { days: number; excluded: string[] }>;
  warnings: string[];
}> {
  const { route, totalNights, startDate, levers, constraints, ctx } = args;
  const order = route.order;
  const t = startTrace("allocateNights", { order, totalNights, startDate });
  const warnings: string[] = [];
  const usable = usableActivityMin(levers);
  t.decide(`usable sightseeing ≈ ${usable} min/day`, "(dayEnd − dayStart − lunch − dinner-if-inside − freeTime) × (1 − bufferPct)");

  // --- demand per city: only places that pass the same hard filters as the pool
  const rules = mobilityRules(levers, constraints);
  const liked = interestTags(constraints).like;
  const tripDates = Array.from({ length: totalNights + 1 }, (_, k) => addDays(startDate, k));
  const demandDays: Record<string, number> = {};
  const demandBeforeFilters: Record<string, { days: number; excluded: string[] }> = {};
  for (const cityId of order) {
    const city = args.cities.find((c) => c.id === cityId)!;
    const priceCap = priceCapPerPerson(city, ctx.budgetTier, constraints, tripDates.length, ctx.pax);
    let minutes = 0;
    let minutesUnfiltered = 0;
    const counted: string[] = [];
    const skipped: string[] = [];
    const roundTrip = (poi: Poi) => (poi.isDayTripFrom ? 2 * taxiMinutes(haversineKm(city, poi), cityId).minutes : 0);
    for (const poi of args.pois) {
      if (poi.cityId !== cityId && poi.isDayTripFrom !== cityId) continue;
      const requested = ctx.requestedPoiIds.has(poi.id);
      const relevant = requested || poi.tier === "must_see" ||
        (poi.tier === "worth_it" && [...poi.interestTags, poi.category].some((tag) => liked.has(tag)));
      if (!relevant) continue;
      minutesUnfiltered += poi.durationMin.typical * levers.durationMultiplier + roundTrip(poi);
      const fail = hardFilterFailure(poi, { dates: tripDates, rules, priceCap, constraints });
      if (fail) {
        skipped.push(`${poi.id} (${fail.reason})`); // can't be visited by this group, so it creates no demand
        continue;
      }
      const version = accessibleVersion(poi, rules);
      const variant = version.ok ? version.variant : null;
      let m = (variant?.durationMin.typical ?? poi.durationMin.typical) * levers.durationMultiplier;
      // Day trips cost their round trip too — Ajanta is ~5h of driving for ~3h of caves.
      m += roundTrip(poi);
      minutes += m;
      counted.push(poi.id);
    }
    demandDays[cityId] = Math.round((minutes / usable) * 100) / 100;
    demandBeforeFilters[cityId] = { days: Math.round((minutesUnfiltered / usable) * 100) / 100, excluded: skipped };
    t.decide(`demand ${cityId} = ${demandDays[cityId]} days`, `${Math.round(minutes)} min over ${counted.length} POIs ÷ ${usable} min/day`, { counted, skipped });
  }

  // --- bounds
  const nightsRule = ofType(constraints, "nights_in_city");
  const bounds = order.map((cityId) => {
    const city = args.cities.find((c) => c.id === cityId)!;
    const rule = nightsRule.find((c) => c.params.cityId === cityId);
    const min = rule?.params.min ?? Math.max(levers.minNightsPerBase, city.minNights);
    const max = rule?.params.max ?? Math.max(min, city.saturationNights);
    return { cityId, min, max };
  });

  const nights = bounds.map((b) => b.min);
  let sum = nights.reduce((a, b) => a + b, 0);
  // Too many minimums: relax soft minimums (not user nights_in_city rules) down to 1, latest cities first.
  for (let i = order.length - 1; i >= 0 && sum > totalNights; i--) {
    const hasRule = nightsRule.some((c) => c.params.cityId === order[i] && c.params.min !== undefined);
    while (!hasRule && nights[i] > 1 && sum > totalNights) { nights[i]--; sum--; }
  }
  if (sum > totalNights) {
    warnings.push(`${order.length} bases need at least ${sum} nights but the trip has ${totalNights}. Consider dropping a city or adding days.`);
  } else if (sum < bounds.reduce((a, b) => a + b.min, 0)) {
    t.decide("relaxed minimum nights", `sum of minimums exceeded ${totalNights} nights`, nights);
  }

  const cap = (i: number, n = nights[i]) => legCapacity(n, i === 0, i === order.length - 1);
  while (sum < totalNights) {
    const gaps = order.map((c, i) => ({ i, gap: demandDays[c] - cap(i), underMax: nights[i] < bounds[i].max }));
    const pool = gaps.some((g) => g.underMax) ? gaps.filter((g) => g.underMax) : gaps;
    if (!gaps.some((g) => g.underMax)) t.decide("exceeding saturation", "every city is at its saturation cap; adding to the neediest anyway");
    const pick = pool.reduce((best, g) => (g.gap > best.gap ? g : best));
    nights[pick.i]++;
    sum++;
    t.decide(`+1 night ${order[pick.i]}`, `largest unmet demand (${Math.round(pick.gap * 100) / 100} days)`);
  }

  // --- overload check
  const totalDemand = order.reduce((s, c) => s + demandDays[c], 0);
  const totalCap = order.reduce((s, _c, i) => s + cap(i), 0);
  if (totalDemand > totalCap * OVERLOAD_THRESHOLD) {
    const options: string[] = [`add ${Math.ceil(totalDemand - totalCap)} day(s)`];
    if (order.length > 1) {
      // Dropping the city with the least to see loses the least and frees its nights for the rest —
      // but you can't drop the city you fly into/out of unless another base can be the gateway.
      const lightest = [...order].sort((a, b) => demandDays[a] - demandDays[b])[0];
      const cityOf = (id: string) => args.cities.find((c) => c.id === id)!;
      const nightsFreed = nights[order.indexOf(lightest)];
      const isGateway = lightest === args.entryCityId || lightest === order[0] || lightest === order.at(-1);
      if (!isGateway) {
        options.push(`drop ${cityOf(lightest).name} (frees ${nightsFreed} night(s) for the rest)`);
      } else {
        const alt = order.filter((c) => c !== lightest).map(cityOf).find((c) => c.gatewayFor.includes("airport") || c.gatewayFor.includes("rail"));
        if (alt) {
          const how = alt.gatewayFor.includes("airport") ? "fly directly to" : "take the train directly to";
          options.push(`skip ${cityOf(lightest).name} and ${how} ${alt.name} (frees ${nightsFreed} night(s))`);
        }
      }
    }
    for (const poi of args.pois) {
      const base = args.cities.find((c) => c.id === poi.isDayTripFrom);
      if (!base || !order.includes(base.id) || !ctx.requestedPoiIds.has(poi.id) || !poi.nearbyStay || !isFarDayTrip(poi, base)) continue;
      const saved = 2 * taxiMinutes(haversineKm(base, poi), base.id).minutes;
      options.push(`stay a night near ${poi.name} in ${poi.nearbyStay.name} (saves ~${round1(saved / 60)}h of driving)`);
    }
    const msg = `Must-sees need ~${round1(totalDemand)} sightseeing days but the trip offers ~${round1(totalCap)}, so some will be skipped. ` +
      `Options: ${options.slice(0, 3).map((o, i) => `(${i + 1}) ${o}`).join("; ")}.`;
    warnings.push(msg);
    t.decide("overloaded", msg);
  }

  // --- dated legs
  const legs: LegAlloc[] = [];
  let dayNumber = 1;
  let date = startDate;
  order.forEach((cityId, i) => {
    const isLast = i === order.length - 1;
    const days = nights[i] + (isLast ? 1 : 0);
    const dates = Array.from({ length: days }, (_, k) => addDays(date, k));
    const inbound = route.hops.find((h) => h.to === cityId) ?? null;
    legs.push({ cityId, nights: nights[i], dates, dayNumbers: dates.map((_, k) => dayNumber + k), inbound, isFirst: i === 0, isLast });
    dayNumber += nights[i];
    date = addDays(date, nights[i]);
  });

  return t.finish({ legs, demandDays, demandBeforeFilters, warnings }, {
    demandBeforeFilters,
    nights: Object.fromEntries(order.map((c, i) => [c, nights[i]])),
    capacityDays: Object.fromEntries(order.map((c, i) => [c, round1(cap(i))])),
    demandDays,
    legs: legs.map((l) => `${l.cityId}: ${l.dates[0]} → ${l.dates.at(-1)} (${l.nights}n)`),
    warnings,
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
