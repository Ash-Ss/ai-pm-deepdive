/**
 * Runs every planner stage in order and assembles the Plan.
 *
 *   form → constraints → levers → bases & route → nights → per leg: pool, hotel
 *   area, day frames → assign (heuristic or AI, then sanitised) → schedule →
 *   validate → repair → validate → Plan
 *
 * Split in two so edits can reuse the first half:
 *   preparePlan   — everything up to the day frames (optionally keeping the
 *                   existing route and nights, for edits that shouldn't move them)
 *   completePlan  — schedule, repair, validate, assemble
 * plus scheduleSingleDay for day-level edits that must leave other days untouched.
 *
 * The only non-deterministic step is `assignFn`; everything it returns is
 * checked by sanitizeAssignment and the validator.
 */
import { type Catalogue, loadCatalogue } from "../catalogue";
import type { Constraint, Day, Item, Leg, Plan, Trace, TripInput } from "../types";
import { allocateNights } from "./allocateNights";
import { type AssignedDay, type AssignFn, type AssignInput, type AssignOutput, isLightItem, sanitizeAssignment } from "./assignDays";
import { chooseBaseArea } from "./baseArea";
import { buildCandidatePool } from "./candidatePool";
import { constraintsFromInput, dedupe, ofType } from "./constraints";
import { buildDayFrames } from "./dayFrames";
import { isFarDayTrip } from "./geo";
import type { CandidatePool, HotelBase, LegAlloc, PlannerContext, ScheduledDay } from "./plannerTypes";
import { type ResolvedLevers, resolveLevers } from "./resolveLevers";
import { classifyPlaces, routeOrder, type RouteResult } from "./routeOrder";
import { scheduleDayBest } from "./scheduleDay";
import { fromMin, toMin } from "./time";
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
    demandBeforeFilters: Record<string, { days: number; excluded: string[] }>;
    pools: Map<string, CandidatePool>;
    hotels: Map<string, HotelBase>;
    scheduled: ScheduledDay[];
  };
};

/** Progress hook for the UI's stage list. */
export type StageName = "route" | "nights" | "places" | "scheduling" | "checking";
export type OnStage = (stage: StageName) => void;

export type PipelineOptions = {
  /** Keep this route and these nights (in this order) instead of recomputing them. */
  fixedLegs?: { cityId: string; nights: number }[];
  /** Items the user locked, by day: they stay on that day whatever the assigner does. */
  locked?: Record<number, string[]>;
  onStage?: OnStage;
};

export type PreparedPlan = {
  input: TripInput;
  constraints: Constraint[];
  ctx: PlannerContext;
  resolved: ResolvedLevers;
  route: RouteResult;
  alloc: { legs: LegAlloc[]; demandDays: Record<string, number>; demandBeforeFilters: Record<string, { days: number; excluded: string[] }> };
  pools: Map<string, CandidatePool>;
  hotels: Map<string, HotelBase>;
  assignInput: AssignInput;
  traces: Trace[];
  warnings: string[];
  catalogue: Catalogue;
};

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export function preparePlan(input: TripInput, chatConstraints: Constraint[], catalogue: Catalogue = loadCatalogue(), opts: PipelineOptions = {}): PreparedPlan {
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
  const bases = opts.fixedLegs
    ? opts.fixedLegs.map((l) => l.cityId)
    : [...new Set([...places.bases, ...ofType(constraints, "city_include").map((c) => c.params.cityId)])].filter((c) => !excluded.has(c));
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

  // --- route (a kept route is enforced with an internal hard city_order)
  opts.onStage?.("route");
  const keepOrder: Constraint[] = opts.fixedLegs && bases.length > 1
    ? [{ id: "keep-route", type: "city_order", params: { cityIds: bases }, strength: "hard", weightLevel: "high", scope: "trip", source: "default", confidence: 1 }]
    : [];
  const route = take(routeOrder({
    cityIds: bases, entryCityId: opts.fixedLegs ? null : input.arrivalCityId, exitCityId: null,
    edges: catalogue.edges, cities: catalogue.cities, constraints: [...constraints, ...keepOrder], levers,
  }));
  for (const v of route.best.breakdown.hardViolations) warnings.push(`Route: ${v}`);

  // --- nights
  opts.onStage?.("nights");
  const alloc = take(allocateNights({
    route: route.best, totalNights: input.days - 1, startDate: input.startDate,
    pois: catalogue.pois, cities: catalogue.cities, levers, constraints, ctx, entryCityId: input.arrivalCityId,
    fixedNights: opts.fixedLegs ? Object.fromEntries(opts.fixedLegs.map((l) => [l.cityId, l.nights])) : undefined,
  }));
  warnings.push(...alloc.warnings);

  // --- per leg: pool, hotel, frames
  opts.onStage?.("places");
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
    for (const o of pool.mobilityOverrides) {
      warnings.push(`${o.name} is included because you asked for it, but it has ${o.reason}. Take it slowly, with rests; skip parts if needed.`);
    }
    // Every must-see we filter out gets explained, with any lighter version.
    for (const m of pool.excludedMustSees) {
      if (ctx.requestedPoiIds.has(m.id)) continue; // already explained above
      if (m.reason === "excluded by user") continue; // they asked for it; no need to tell them
      warnings.push(`Skipped must-see ${m.name}: ${m.reason}.${m.variantNote ? ` ${m.variantNote}` : ""}`);
    }
    const hotel = take(chooseBaseArea(city, pool, walkingLimited));
    const frames = take(buildDayFrames({ leg, levers, events: catalogue.events, constraints, pool, cities: catalogue.cities, presets: catalogue.presets }));
    pools.set(leg.cityId, pool);
    hotels.set(leg.cityId, hotel);
    assignInput.legs.push({ cityId: leg.cityId, hotel, frames, pool });
  }

  return { input, constraints, ctx, resolved, route, alloc, pools, hotels, assignInput, traces, warnings, catalogue };
}

// ---------------------------------------------------------------------------
// Scheduling helpers shared by full plans and single-day edits
// ---------------------------------------------------------------------------

function scheduler(prep: PreparedPlan, restaurantUseFor: (dayNumber: number) => Map<string, number>) {
  const { levers } = prep.resolved;
  return (s: DayState) =>
    scheduleDayBest({
      frame: s.frame, itemIds: s.itemIds, pool: prep.pools.get(s.frame.cityId)!, levers, hotel: prep.hotels.get(s.frame.cityId)!, ctx: prep.ctx,
      forceTaxi: s.forceTaxi, minimizeWalking: s.minimizeWalking, variantIds: s.variantIds, reasons: s.reasons, tradeoffs: s.tradeoffs,
      restaurantUse: restaurantUseFor(s.frame.dayNumber), source: s.source,
    });
}

const canPlaceFor = (prep: PreparedPlan) => (refId: string, target: DayState) => {
  if (!target.frame.lightOnly) return true;
  const p = prep.pools.get(target.frame.cityId)!.pois.find((x) => x.id === refId);
  return !!p && isLightItem(p, prep.hotels.get(target.frame.cityId)!.area);
};

const validateCtxFor = (prep: PreparedPlan) => ({ levers: prep.resolved.levers, constraints: prep.constraints, pools: prep.pools, ctx: prep.ctx, cities: prep.catalogue.cities });

function stateFor(frame: DayState["frame"], a: AssignedDay | undefined, source: "planner" | "ai"): DayState {
  return {
    frame, itemIds: a?.itemIds ?? [], forceTaxi: false, minimizeWalking: false,
    variantIds: new Set<string>(a?.variantIds ?? []), reasons: a?.reasons ?? {}, tradeoffs: {},
    source: a?.source ?? source, theme: a?.theme,
  };
}

export function toDay(d: ScheduledDay, theme?: string): Day {
  return {
    dayNumber: d.frame.dayNumber,
    date: d.frame.date,
    cityId: d.frame.cityId,
    title: theme ?? dayTitle(d.items, d.frame),
    items: d.items,
    totals: d.totals,
  };
}

/** Keep locked items on their day: take them off any other day, add them where they were locked. */
export function applyLocked(out: AssignOutput, locked: Record<number, string[]> = {}): AssignOutput {
  const lockedIds = new Set(Object.values(locked).flat());
  if (!lockedIds.size) return out;
  return {
    ...out,
    days: out.days.map((d) => {
      const keep = d.itemIds.filter((id) => !lockedIds.has(id));
      const mine = locked[d.dayNumber] ?? [];
      return { ...d, itemIds: [...mine, ...keep], reasons: { ...d.reasons, ...Object.fromEntries(mine.map((id) => [id, ["you locked this"]])) } };
    }),
  };
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export function completePlan(prep: PreparedPlan, assigned: AssignOutput, opts: PipelineOptions = {}): PipelineResult {
  const { traces, warnings, pools, hotels, ctx, catalogue, constraints } = prep;
  const { levers } = prep.resolved;
  const take = <T>(r: { result: T; trace: Trace }) => (traces.push(r.trace), r.result);

  opts.onStage?.("scheduling");
  const states: DayState[] = prep.assignInput.legs.flatMap((leg) =>
    leg.frames.map((frame) => stateFor(frame, assigned.days.find((d) => d.dayNumber === frame.dayNumber), assigned.source)),
  );
  // Restaurant variety needs to know what other days already use, so remember the latest schedule of each day.
  const latest = new Map<number, ScheduledDay>();
  const schedule = scheduler(prep, (dayNumber) => restaurantUse([...latest.entries()].filter(([n]) => n !== dayNumber).map(([, d]) => d.items)));
  const scheduleAndRemember = (s: DayState) => {
    const r = schedule(s);
    latest.set(s.frame.dayNumber, r.result);
    return r;
  };
  const validateCtx = validateCtxFor(prep);

  // Keep one scheduling trace per day (from the initial pass) for the behind-the-scenes view.
  const initialDays = states.map((s) => {
    const r = scheduleAndRemember(s);
    traces.push(r.trace);
    return r.result;
  });
  opts.onStage?.("checking");
  traces.push(validatePlan(initialDays, validateCtx).trace);
  const repaired = take(repairPlan({
    states, schedule: (s) => scheduleAndRemember(s).result, pools, canPlace: canPlaceFor(prep),
    validate: (days) => validatePlan(days, validateCtx).result,
  }));
  warnings.push(...repaired.warnings);
  const final = take(validatePlan(repaired.days, validateCtx));

  // Early starts become rejectable chips: a soft day_window the UI can show. Rejecting it means sending
  // back a hard day_window for that day, which stops dayFrames from allowing the override.
  const chips = earlyStartChips(repaired.days);
  warnings.push(...dayTripWarnings(prep, repaired.days));

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
  const legs: Leg[] = prep.alloc.legs.map((leg) => ({
    cityId: leg.cityId,
    baseAreaId: hotels.get(leg.cityId)!.area.id,
    nights: leg.nights,
    days: repaired.days
      .filter((d) => d.frame.cityId === leg.cityId && leg.dayNumbers.includes(d.frame.dayNumber))
      .map((d) => toDay(d, states.find((s) => s.frame.dayNumber === d.frame.dayNumber)?.theme)),
  }));

  const plan: Plan = {
    id: `plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    input: prep.input,
    constraints: [...constraints, ...chips],
    levers,
    legs,
    warnings,
    traces,
  };
  return {
    plan,
    traces,
    validation: final,
    debug: {
      levers: prep.resolved, route: prep.route, demandDays: prep.alloc.demandDays, demandBeforeFilters: prep.alloc.demandBeforeFilters,
      pools, hotels, scheduled: repaired.days,
    },
  };
}

export async function runPipeline(
  input: TripInput,
  chatConstraints: Constraint[],
  assignFn: AssignFn,
  catalogue: Catalogue = loadCatalogue(),
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const prep = preparePlan(input, chatConstraints, catalogue, opts);
  const raw = await assignFn(prep.assignInput);
  const assigned = sanitizeAssignment(prep.assignInput, applyLocked(raw, opts.locked));
  prep.traces.push(assigned.trace);
  return completePlan(prep, assigned.result, opts);
}

// ---------------------------------------------------------------------------
// Single-day edits
// ---------------------------------------------------------------------------

/**
 * Re-schedule one day with the given items, leaving every other day as it is.
 * Other days only inform restaurant variety. Repair runs on this day alone
 * (walk→taxi, variant, drop — moves would touch other days, so they can't happen).
 */
export function scheduleSingleDay(
  prep: PreparedPlan,
  plan: Plan,
  dayNumber: number,
  assigned: AssignedDay,
): { day: ScheduledDay; warnings: string[]; trace: Trace } {
  const frame = prep.assignInput.legs.flatMap((l) => l.frames).find((f) => f.dayNumber === dayNumber);
  if (!frame) throw new Error(`No day ${dayNumber} in this plan`);
  const others = plan.legs.flatMap((l) => l.days).filter((d) => d.dayNumber !== dayNumber);
  const use = restaurantUse(others.map((d) => d.items));
  const schedule = scheduler(prep, () => use);
  const state = stateFor(frame, assigned, assigned.source ?? "planner");
  const repaired = repairPlan({
    states: [state], schedule: (s) => schedule(s).result, pools: prep.pools, canPlace: canPlaceFor(prep),
    validate: (days) => validatePlan(days, validateCtxFor(prep)).result,
  });
  return { day: repaired.result.days[0], warnings: repaired.result.warnings, trace: repaired.trace };
}

// ---------------------------------------------------------------------------

function restaurantUse(dayItems: Item[][]): Map<string, number> {
  const use = new Map<string, number>();
  for (const items of dayItems) for (const m of items) if (m.type === "meal" && m.refId) use.set(m.refId, (use.get(m.refId) ?? 0) + 1);
  return use;
}

export function earlyStartChips(days: ScheduledDay[]): Constraint[] {
  return days.filter((d) => d.startOverride).map((d) => {
    const n = d.frame.dayNumber;
    return {
      id: `auto-early-start-day-${n}`, type: "day_window" as const, params: { start: fromMin(d.startOverride!.toMin) },
      strength: "soft" as const, weightLevel: "medium" as const, scope: `day:${n}`, source: "default" as const, confidence: 1,
      sourceText: `Day ${n} leaves at ${fromMin(d.startOverride!.toMin)} instead of ${fromMin(d.startOverride!.fromMin)} for the long drive, so lunch and return aren't late`,
    };
  });
}

/** Long requested day trips: say how much driving it really is, and offer the overnight alternative. */
export function dayTripWarnings(prep: PreparedPlan, days: ScheduledDay[]): string[] {
  const out: string[] = [];
  const { levers } = prep.resolved;
  for (const d of days) {
    const pool = prep.pools.get(d.frame.cityId)!;
    const hotel = prep.hotels.get(d.frame.cityId)!.area;
    for (const it of d.items.filter((i) => i.type === "activity")) {
      const p = pool.pois.find((x) => x.id === it.refId);
      if (!p?.isDayTrip || !p.requested) continue;
      const rides = d.items.filter((i) => i.type === "transfer" && i.transfer?.mode === "auto_taxi");
      const drive = rides.reduce((s, i) => s + (toMin(i.endTime) - toMin(i.startTime)), 0);
      if (drive > levers.maxTransitMinPerDay) {
        const km = Math.round(rides.reduce((s, i) => s + (i.transfer?.distanceKm ?? 0), 0));
        const carCost = rides.reduce((s, i) => s + (i.costINR ?? 0), 0);
        out.push(
          `Day ${d.frame.dayNumber}: ${p.poi.name} means ~${hm(drive)} in a car (your limit is ${hm(levers.maxTransitMinPerDay)}). ` +
          `Book a private car with driver for the whole day: est. ₹${(Math.round(carCost / 100) * 100).toLocaleString("en-IN")} ` +
          `(~${km} km × ₹20/km planner rate; confirm with the operator).`,
        );
      }
      if (isFarDayTrip(p.poi, hotel) && p.poi.nearbyStay) {
        out.push(`Alternative for ${p.poi.name}: stay a night in ${p.poi.nearbyStay.name}. ${p.poi.nearbyStay.note}`);
      }
    }
  }
  return out;
}

const hm = (min: number) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;

function dayTitle(items: Item[], frame: ScheduledDay["frame"]): string {
  const acts = items.filter((i) => i.type === "activity").map((i) => i.title.split(" — ")[0]);
  const prefix = frame.isTravel ? "Travel + " : frame.isArrival ? "Arrival + " : frame.isDeparture ? "Departure + " : "";
  return acts.length ? `${prefix}${acts.slice(0, 2).join(" & ")}${acts.length > 2 ? " & more" : ""}` : `${prefix}At leisure`.replace(/ \+ At/, ", at");
}
