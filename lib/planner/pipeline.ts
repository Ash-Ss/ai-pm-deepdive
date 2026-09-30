/**
 * Runs every planner stage in order and assembles the Plan.
 *
 *   form → constraints → levers → bases & route → nights → per leg: pool, hotel
 *   area, day frames → assign (heuristic or AI, then sanitised) → schedule →
 *   validate → repair → validate → Plan
 *
 * The only non-deterministic step is `assignFn`; everything it returns is
 * checked by sanitizeAssignment and the validator.
 */
import { type Catalogue, loadCatalogue } from "../catalogue";
import type { Constraint, Day, Item, Leg, Plan, Trace, TripInput } from "../types";
import { allocateNights } from "./allocateNights";
import { type AssignFn, type AssignInput, sanitizeAssignment } from "./assignDays";
import { chooseBaseArea } from "./baseArea";
import { buildCandidatePool } from "./candidatePool";
import { constraintsFromInput, dedupe, ofType } from "./constraints";
import { buildDayFrames } from "./dayFrames";
import type { CandidatePool, HotelBase, PlannerContext, ScheduledDay } from "./plannerTypes";
import { type ResolvedLevers, resolveLevers } from "./resolveLevers";
import { classifyPlaces, routeOrder, type RouteResult } from "./routeOrder";
import { scheduleDay } from "./scheduleDay";
import { type DayState, repairPlan, type ValidationReport, validatePlan } from "./validatePlan";

export type PipelineResult = {
  plan: Plan;
  traces: Trace[];
  validation: ValidationReport;
  /** Intermediate results, handy for the demo and a behind-the-scenes view. */
  debug: {
    levers: ResolvedLevers;
    route: RouteResult;
    demandDays: Record<string, number>;
    pools: Map<string, CandidatePool>;
    hotels: Map<string, HotelBase>;
    scheduled: ScheduledDay[];
  };
};

export async function runPipeline(
  input: TripInput,
  chatConstraints: Constraint[],
  assignFn: AssignFn,
  catalogue: Catalogue = loadCatalogue(),
): Promise<PipelineResult> {
  const traces: Trace[] = [];
  const warnings: string[] = [];
  const take = <T>(r: { result: T; trace: Trace }) => (traces.push(r.trace), r.result);

  if (!input.startDate) throw new Error("startDate is required to plan (weekday closures depend on it)");

  // --- places → bases + requested day trips
  const places = take(classifyPlaces(input.cityIds, catalogue.cities, catalogue.pois));
  for (const u of places.unknown) warnings.push(`Unknown place "${u}" ignored.`);
  const dayTripConstraints: Constraint[] = places.dayTrips.map((d, i) => ({
    id: `place-${i + 1}`, type: "poi_include", params: { poiId: d.poiId }, strength: "hard", weightLevel: "high",
    scope: "trip", source: "form", sourceText: `named place: ${d.poiId}`, confidence: 1,
  }));
  const constraints = dedupe([...constraintsFromInput(input), ...dayTripConstraints, ...chatConstraints]);
  // Cities the chat asked to include/exclude adjust the base list.
  const excluded = new Set(ofType(constraints, "city_exclude").map((c) => c.params.cityId));
  const bases = [...new Set([...places.bases, ...ofType(constraints, "city_include").map((c) => c.params.cityId)])].filter((c) => !excluded.has(c));
  if (bases.length === 0) throw new Error("No base cities to plan for");

  const ctx: PlannerContext = {
    budgetTier: input.budgetTier,
    pax: input.travellers.adults + input.travellers.children + input.travellers.seniors,
    travellers: input.travellers,
    requestedPoiIds: new Set(ofType(constraints, "poi_include").map((c) => c.params.poiId)),
  };

  // --- levers
  const resolved = take(resolveLevers(constraints, catalogue.presets, input.presets));
  const { levers } = resolved;

  // --- route
  const route = take(routeOrder({
    cityIds: bases, entryCityId: input.arrivalCityId, exitCityId: null,
    edges: catalogue.edges, cities: catalogue.cities, constraints, levers,
  }));
  for (const v of route.best.breakdown.hardViolations) warnings.push(`Route: ${v}`);

  // --- nights
  const alloc = take(allocateNights({
    route: route.best, totalNights: input.days - 1, startDate: input.startDate,
    pois: catalogue.pois, cities: catalogue.cities, levers, constraints, ctx,
  }));
  warnings.push(...alloc.warnings);

  // --- per leg: pool, hotel, frames
  const pools = new Map<string, CandidatePool>();
  const hotels = new Map<string, HotelBase>();
  const assignInput: AssignInput = { legs: [], levers, constraints };
  const walkingLimited = levers.maxWalkKmPerDay <= 4;
  for (const leg of alloc.legs) {
    const city = catalogue.cities.find((c) => c.id === leg.cityId)!;
    const pool = take(buildCandidatePool({
      cityId: leg.cityId, dates: leg.dates, pois: catalogue.pois, restaurants: catalogue.restaurants,
      experiences: catalogue.experiences, cities: catalogue.cities, events: catalogue.events, levers, constraints, weights: catalogue.weights, ctx,
    }));
    for (const id of ctx.requestedPoiIds) {
      const poi = catalogue.pois.find((p) => p.id === id);
      if ((poi?.cityId === leg.cityId || poi?.isDayTripFrom === leg.cityId) && !pool.pois.some((p) => p.id === id)) {
        const why = pool.funnel.flatMap((f) => f.removed).find((r) => r.startsWith(`${id}:`));
        warnings.push(`You asked for ${poi.name}, but it can't be included (${why?.split(": ").slice(1).join(": ") ?? "filtered out"}).`);
      }
    }
    const hotel = take(chooseBaseArea(city, pool, walkingLimited));
    const frames = take(buildDayFrames({ leg, levers, events: catalogue.events, constraints, pool }));
    pools.set(leg.cityId, pool);
    hotels.set(leg.cityId, hotel);
    assignInput.legs.push({ cityId: leg.cityId, hotel, frames, pool });
  }

  // --- assign (heuristic or AI), then guard
  const assigned = take(sanitizeAssignment(assignInput, await assignFn(assignInput)));

  // --- schedule, validate, repair
  const states: DayState[] = assignInput.legs.flatMap((leg) =>
    leg.frames.map((frame) => {
      const a = assigned.days.find((d) => d.dayNumber === frame.dayNumber);
      return { frame, itemIds: a?.itemIds ?? [], forceTaxi: false, variantIds: new Set<string>(), reasons: a?.reasons ?? {}, tradeoffs: {} };
    }),
  );
  const schedule = (s: DayState) =>
    scheduleDay({
      frame: s.frame, itemIds: s.itemIds, pool: pools.get(s.frame.cityId)!, levers, hotel: hotels.get(s.frame.cityId)!, ctx,
      forceTaxi: s.forceTaxi, variantIds: s.variantIds, reasons: s.reasons, tradeoffs: s.tradeoffs, source: assigned.source,
    }).result;
  const validateCtx = { levers, constraints, pools, ctx, cities: catalogue.cities };

  // Keep one scheduling trace per day (from the initial pass) for the behind-the-scenes view.
  for (const s of states) {
    traces.push(scheduleDay({
      frame: s.frame, itemIds: s.itemIds, pool: pools.get(s.frame.cityId)!, levers, hotel: hotels.get(s.frame.cityId)!, ctx,
      reasons: s.reasons, source: assigned.source,
    }).trace);
  }
  const initial = validatePlan(states.map(schedule), validateCtx);
  traces.push(initial.trace);
  const repaired = take(repairPlan({
    states, schedule, pools,
    validate: (days) => validatePlan(days, validateCtx).result,
  }));
  warnings.push(...repaired.warnings);
  const final = take(validatePlan(repaired.days, validateCtx));

  // Anything the user explicitly asked for must be in the plan, or they must be told why not.
  const scheduledIds = new Set(repaired.days.flatMap((d) => d.items.map((i) => i.refId)));
  for (const id of ctx.requestedPoiIds) {
    const inPool = [...pools.values()].some((p) => p.pois.some((x) => x.id === id));
    if (inPool && !scheduledIds.has(id)) {
      const name = catalogue.pois.find((p) => p.id === id)?.name ?? id;
      warnings.push(`You asked for ${name}, but it didn't fit any day (opening hours, closures or time). Consider adding a day.`);
    }
  }
  if (final.soft.budget.overCap) warnings.push(`Estimated cost ₹${final.soft.budget.estimatedINR} exceeds your cap of ₹${final.soft.budget.capINR}.`);

  // --- assemble
  const legs: Leg[] = alloc.legs.map((leg) => ({
    cityId: leg.cityId,
    baseAreaId: hotels.get(leg.cityId)!.area.id,
    nights: leg.nights,
    days: repaired.days
      .filter((d) => d.frame.cityId === leg.cityId && leg.dayNumbers.includes(d.frame.dayNumber))
      .map((d): Day => ({
        dayNumber: d.frame.dayNumber,
        date: d.frame.date,
        cityId: d.frame.cityId,
        title: dayTitle(d.items, d.frame),
        items: d.items,
        totals: d.totals,
      })),
  }));

  const plan: Plan = {
    id: `plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    input,
    constraints,
    levers,
    legs,
    warnings,
    traces,
  };
  return {
    plan,
    traces,
    validation: final,
    debug: { levers: resolved, route, demandDays: alloc.demandDays, pools, hotels, scheduled: repaired.days },
  };
}

function dayTitle(items: Item[], frame: ScheduledDay["frame"]): string {
  const acts = items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);
  const prefix = frame.isTravel ? "Travel + " : frame.isArrival ? "Arrival + " : frame.isDeparture ? "Departure + " : "";
  return acts.length ? `${prefix}${acts.slice(0, 2).join(" & ")}${acts.length > 2 ? " & more" : ""}` : `${prefix}At leisure`.replace(/ \+ At/, ", at");
}
