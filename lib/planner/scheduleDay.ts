/**
 * Stage 6 — turn a day's assigned places into a timed itinerary.
 *
 * Each candidate ordering is fully simulated (travel, opening hours, fixed start
 * times, lunch, rest breaks, evening and dinner) and costed as
 *   travel minutes + weighted soft penalties.
 * Lunch is itself a stop in the ordering, so the search can choose between e.g.
 * "lunch first" and "late lunch after the caves". With ≤ 7 places we try every
 * ordering (≤ 8! = 40,320 simulations — a few ms each); beyond that, greedy
 * nearest-neighbour.
 */
import type { Item, ItemType, Levers, StageResult, Tier } from "../types";
import { haversineKm, type LatLng, localLeg, round1, taxiMinutes } from "./geo";
import type { CandidatePool, DayFrame, HotelBase, PlannerContext, ScheduledDay } from "./plannerTypes";
import { fromMin, overlapMin, toMin } from "./time";
import { startTrace } from "./trace";

const MAX_PERMUTE = 7;
const REST_MIN = 15;
const MEAL_FALLBACK_MIN = 60;
const MAX_RESTAURANT_KM = 5; // further than this, suggest "somewhere local" instead
const MIN_GAP_ITEM = 10; // gaps shorter than this aren't worth showing
const TAXI_INR_PER_KM = 20;
const MEAL_INR_PER_PERSON: Record<Tier, number> = { budget: 250, mid: 600, premium: 1500 };

/** Soft penalty weights (in "minutes of travel" equivalents). */
const W = {
  waitingPerMin: 0.5,
  lunchWaitPerMin: 0.25,
  timeOfDayMismatch: 30,
  avoidPerMin: 1,
  crowded: 20,
  lateMealPerMin: 1,
  freeTimeShortPerMin: 0.5,
  skipped: 1000,
};

type Loc = LatLng & { name: string };
type Stop =
  | {
      kind: "activity";
      refId: string;
      title: string;
      loc: Loc;
      durationMin: number;
      openRanges: [number, number][];
      fixedStarts: number[] | null; // experiences run at set times
      bestTimeOfDay: string;
      avoid: [number, number][];
      walkM: number;
      flat: boolean;
      priceINR: number;
      crowded: boolean;
      variantName: string | null;
    }
  | { kind: "lunch" };

type Ev = {
  type: ItemType;
  start: number;
  end: number;
  title: string;
  refId: string | null;
  transfer?: Item["transfer"];
  cost: number;
  walkKm: number;
  transitMin: number;
  tradeoffs: string[];
};

type SimResult = { evs: Ev[]; cost: number; penalties: Record<string, number>; dropped: { refId: string; reason: string }[] };

export function scheduleDay(args: {
  frame: DayFrame;
  itemIds: string[];
  pool: CandidatePool;
  levers: Levers;
  hotel: HotelBase;
  ctx: PlannerContext;
  forceTaxi?: boolean;
  /** POIs to do as their lighter variant (set by repair). */
  variantIds?: Set<string>;
  reasons?: Record<string, string[]>;
  tradeoffs?: Record<string, string[]>;
  source?: Item["source"];
}): StageResult<ScheduledDay> {
  const { frame, itemIds, pool, levers, hotel, ctx } = args;
  const t = startTrace(`scheduleDay:${frame.dayNumber}`, { date: frame.date, weekday: frame.weekday, itemIds, forceTaxi: !!args.forceTaxi });
  const cityId = frame.cityId;
  const hotelLoc: Loc = { lat: hotel.area.lat, lng: hotel.area.lng, name: `hotel (${hotel.area.name})` };
  const cars = Math.ceil(ctx.pax / 4);
  const rooms = Math.ceil(ctx.pax / 2);
  const lunch = { start: toMin(levers.lunchWindow.start), end: toMin(levers.lunchWindow.end) };
  const dinner = { start: toMin(levers.dinnerWindow.start), end: toMin(levers.dinnerWindow.end) };
  const restEvery = levers.restBreakEveryMin;

  // ---- build stops
  const stops: Stop[] = [];
  for (const id of itemIds) {
    const p = pool.pois.find((x) => x.id === id);
    if (p) {
      const forced = args.variantIds?.has(id) && !p.variant ? p.poi.variants?.[0] ?? null : null;
      const variant = forced ?? p.variant;
      const duration = forced ? Math.round(forced.durationMin.typical * levers.durationMultiplier) : p.durationMin;
      const acc = forced ? { ...p.accessibility, ...forced.accessibility } : p.accessibility;
      stops.push({
        kind: "activity",
        refId: id,
        title: variant ? `${p.poi.name} — ${variant.name.replace(/^.*?–\s*/, "")}` : p.poi.name,
        loc: { lat: p.poi.lat, lng: p.poi.lng, name: p.poi.name },
        durationMin: duration,
        openRanges: p.poi.openingHours[frame.weekday as keyof typeof p.poi.openingHours].map(([o, c]) => [toMin(o), toMin(c)]),
        fixedStarts: null,
        bestTimeOfDay: p.poi.bestTimeOfDay,
        avoid: p.poi.avoidTimes.map((w) => [toMin(w.start), toMin(w.end)]),
        walkM: acc.walkingRequiredM,
        flat: acc.terrain === "flat",
        priceINR: p.poi.priceINR,
        crowded: frame.crowdedPoiIds.includes(id),
        variantName: variant?.name ?? null,
      });
      continue;
    }
    const x = pool.experiences.find((e) => e.id === id);
    if (x) {
      const operates = x.experience.daysOperating.includes(frame.weekday as never);
      const linked = pool.pois.find((pp) => x.experience.linkedPoiIds.includes(pp.id))?.poi;
      const loc = linked ? { lat: linked.lat, lng: linked.lng, name: x.experience.name } : { ...hotelLoc, name: x.experience.name };
      stops.push({
        kind: "activity",
        refId: id,
        title: x.experience.name,
        loc,
        durationMin: x.experience.durationMin,
        openRanges: operates ? [[0, 24 * 60 - 1]] : [],
        fixedStarts: operates ? x.experience.startTimes.map(toMin).sort((a, b) => a - b) : [],
        bestTimeOfDay: "any",
        avoid: [],
        walkM: x.experience.accessibility.walkingRequiredM,
        flat: x.experience.accessibility.terrain === "flat",
        priceINR: x.experience.priceINR,
        crowded: false,
        variantName: null,
      });
      continue;
    }
    t.decide(`ignored ${id}`, "not in this leg's candidate pool");
  }

  const needsLunch = frame.startMin < lunch.end && frame.endMin > lunch.start && stops.length > 0;
  const allStops: Stop[] = needsLunch ? [...stops, { kind: "lunch" }] : stops;

  // ---- helpers
  const nearestRestaurant = (from: LatLng, meal: "lunch" | "dinner") => {
    const options = pool.restaurants
      .filter((r) => r.mealTypes.includes(meal))
      .map((r) => ({ r, km: haversineKm(from, r) }))
      .sort((a, b) => a.km - b.km);
    return options[0] && options[0].km <= MAX_RESTAURANT_KM ? options[0].r : null;
  };
  const mealCost = (band: Tier) => MEAL_INR_PER_PERSON[band] * ctx.pax;

  function earliestStart(s: Extract<Stop, { kind: "activity" }>, arrive: number): number | null {
    if (s.fixedStarts) return s.fixedStarts.find((st) => st >= arrive) ?? null;
    for (const [o, c] of s.openRanges) {
      const start = Math.max(arrive, o);
      if (start + s.durationMin <= c) return start;
    }
    return null;
  }

  function timeOfDayMismatch(best: string, start: number, end: number): boolean {
    if (best === "morning") return start >= 12 * 60;
    if (best === "afternoon") return start < 12 * 60 || start >= 16 * 60;
    if (best === "evening") return overlapMin(start, end, 16 * 60, 20 * 60) === 0;
    if (best === "sunset") return overlapMin(start, end, 17 * 60 + 30, 19 * 60) < 15;
    return false;
  }

  // ---- simulate one ordering
  function simulate(order: Stop[]): SimResult {
    const evs: Ev[] = [];
    const pen: Record<string, number> = { travel: 0, waiting: 0, timeOfDay: 0, avoidTimes: 0, crowd: 0, lateMeal: 0, freeTimeShort: 0, skipped: 0 };
    const dropped: SimResult["dropped"] = [];
    let time = frame.startMin;
    let pos: Loc = hotelLoc;
    let sinceRest = 0;
    let lastActivity = "";

    const go = (to: Loc, flat: boolean, at: number) => {
      const leg = localLeg(pos, to, cityId, levers, { flatTerrain: flat, forceTaxi: args.forceTaxi });
      if (leg.minutes > 0) {
        const taxi = leg.mode === "auto_taxi";
        evs.push({
          type: "transfer", start: at, end: at + leg.minutes,
          title: `${taxi ? "Auto/taxi" : "Walk"} to ${to.name}`, refId: null,
          transfer: { mode: leg.mode, distanceKm: leg.km },
          cost: taxi ? Math.round(leg.km * TAXI_INR_PER_KM) * cars : 0,
          walkKm: taxi ? 0 : leg.km, transitMin: taxi ? leg.minutes : 0, tradeoffs: [],
        });
        pen.travel += leg.minutes;
      }
      pos = to;
      return at + leg.minutes;
    };

    for (const s of order) {
      if (s.kind === "lunch") {
        const r = nearestRestaurant(pos, "lunch");
        const loc: Loc = r ? { lat: r.lat, lng: r.lng, name: r.name } : pos;
        const leg = localLeg(pos, loc, cityId, levers, { flatTerrain: true, forceTaxi: args.forceTaxi });
        const start = Math.max(time + leg.minutes, lunch.start);
        const tradeoffs: string[] = [];
        if (start > lunch.end) {
          pen.lateMeal += (start - lunch.end) * W.lateMealPerMin;
          tradeoffs.push(`Late lunch${lastActivity ? ` so ${lastActivity} fits its opening hours` : ""}`);
        }
        pen.waiting += (start - time - leg.minutes) * W.lunchWaitPerMin;
        go(loc, true, time);
        const dur = r?.avgMealMin ?? MEAL_FALLBACK_MIN;
        evs.push({
          type: "meal", start, end: start + dur, refId: r?.id ?? null, tradeoffs,
          title: r ? `Lunch at ${r.name}` : `Lunch near ${pos.name} (local restaurant)`,
          cost: mealCost(r?.priceBand ?? ctx.budgetTier), walkKm: 0, transitMin: 0,
        });
        time = start + dur;
        sinceRest = 0;
        continue;
      }

      if (sinceRest >= restEvery) {
        evs.push({ type: "rest", start: time, end: time + REST_MIN, title: "Rest / chai break", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
        time += REST_MIN;
        sinceRest = 0;
      }

      const leg = localLeg(pos, s.loc, cityId, levers, { flatTerrain: s.flat, forceTaxi: args.forceTaxi });
      const arrive = time + leg.minutes;
      const start = earliestStart(s, arrive);
      if (start === null || start + s.durationMin > frame.endMin) {
        dropped.push({ refId: s.refId, reason: start === null ? `closed or no slot on ${frame.weekday} after ${fromMin(arrive)}` : `would end after ${fromMin(frame.endMin)}` });
        pen.skipped += W.skipped;
        continue;
      }
      go(s.loc, s.flat, time);
      pen.waiting += (start - arrive) * W.waitingPerMin;
      const end = start + s.durationMin;
      if (timeOfDayMismatch(s.bestTimeOfDay, start, end)) pen.timeOfDay += W.timeOfDayMismatch;
      for (const [a, b] of s.avoid) pen.avoidTimes += overlapMin(start, end, a, b) * W.avoidPerMin;
      if (s.crowded) pen.crowd += W.crowded;
      evs.push({
        type: "activity", start, end, title: s.title, refId: s.refId,
        cost: s.priceINR * ctx.pax, walkKm: s.walkM / 1000, transitMin: 0,
        tradeoffs: s.variantName ? [`Doing "${s.variantName}" rather than the full visit to keep walking/stairs manageable`] : [],
      });
      sinceRest += s.durationMin + (leg.mode === "walk" ? leg.minutes : 0);
      lastActivity = s.title;
      time = end + Math.round(levers.bufferPct * s.durationMin); // buffer shows up as a gap
    }

    // ---- end of day
    if (frame.isDeparture) {
      time = go(hotelLoc, true, time);
      evs.push({ type: "transfer", start: time, end: time, title: `Collect bags and depart ${cityId}`, refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
    } else {
      const atHotel = go(hotelLoc, true, time);
      const r = nearestRestaurant(hotelLoc, "dinner");
      const dLoc: Loc = r ? { lat: r.lat, lng: r.lng, name: r.name } : hotelLoc;
      const legMin = localLeg(hotelLoc, dLoc, cityId, levers, { flatTerrain: true, forceTaxi: args.forceTaxi }).minutes;
      let dinnerStart = Math.max(dinner.start, atHotel + levers.freeTimeMin + legMin);
      if (dinnerStart > dinner.end) dinnerStart = Math.max(dinner.end, atHotel + legMin);
      const leave = dinnerStart - legMin;
      const free = leave - atHotel;
      if (free < levers.freeTimeMin) pen.freeTimeShort += (levers.freeTimeMin - free) * W.freeTimeShortPerMin;
      if (free >= MIN_GAP_ITEM) {
        evs.push({ type: "free_time", start: atHotel, end: leave, title: "Free time / rest at hotel", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
      }
      go(dLoc, true, leave);
      const dur = r?.avgMealMin ?? MEAL_FALLBACK_MIN;
      const dinnerTradeoffs: string[] = [];
      if (dinnerStart > dinner.end) {
        pen.lateMeal += (dinnerStart - dinner.end) * W.lateMealPerMin;
        dinnerTradeoffs.push("Later dinner than you'd like, because of the long day");
      }
      evs.push({
        type: "meal", start: dinnerStart, end: dinnerStart + dur, refId: r?.id ?? null, tradeoffs: dinnerTradeoffs,
        title: r ? `Dinner at ${r.name}` : "Dinner near hotel (local restaurant)",
        cost: mealCost(r?.priceBand ?? ctx.budgetTier), walkKm: 0, transitMin: 0,
      });
      const back = go(hotelLoc, true, dinnerStart + dur);
      evs.push({
        type: "hotel", start: back, end: back, title: `Overnight at ${hotel.area.name}`, refId: hotel.area.id,
        cost: hotel.area.hotelPriceBand[ctx.budgetTier] * rooms, walkKm: 0, transitMin: 0, tradeoffs: [],
      });
    }

    const cost = Object.values(pen).reduce((a, b) => a + b, 0);
    return { evs, cost, penalties: pen, dropped };
  }

  // ---- search
  let best: SimResult | null = null;
  let tried = 0;
  if (stops.length <= MAX_PERMUTE) {
    for (const order of permutations(allStops)) {
      tried++;
      const r = simulate(order);
      if (!best || r.cost < best.cost) best = r;
    }
  } else {
    best = simulate(greedyOrder(allStops, hotelLoc));
    tried = 1;
  }
  const sim = best ?? simulate([]);
  t.decide(
    stops.length <= MAX_PERMUTE ? `best of ${tried} orderings` : "greedy nearest-neighbour ordering",
    `cost ${Math.round(sim.cost)} = travel + weighted penalties`,
    roundAll(sim.penalties),
  );
  for (const d of sim.dropped) t.decide(`could not fit ${d.refId}`, d.reason);

  // ---- prefix: arrival / intercity transfer
  const prefix: Ev[] = [];
  if (frame.transfer) {
    const { hop } = frame.transfer;
    const mid = (hop.edge.fareBandINR.min + hop.edge.fareBandINR.max) / 2;
    prefix.push({
      type: "transfer", start: frame.transfer.startMin, end: frame.transfer.endMin,
      title: `${cap(hop.edge.mode)} ${hop.from} → ${hop.to} (door to door)`, refId: null,
      transfer: { mode: hop.edge.mode, distanceKm: 0 },
      cost: Math.round(mid * (hop.edge.mode === "road" ? cars : ctx.pax)), walkKm: 0, transitMin: 0,
      tradeoffs: hop.alternatives.length ? [`Alternatives: ${hop.alternatives.join(", ")}`] : [],
    });
    prefix.push({ type: "hotel", start: frame.transfer.endMin, end: frame.startMin, title: `Check in at ${hotel.area.name}`, refId: hotel.area.id, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
  } else if (frame.isArrival) {
    prefix.push({ type: "hotel", start: frame.startMin - 30, end: frame.startMin, title: `Arrive and check in at ${hotel.area.name}`, refId: hotel.area.id, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
  }

  // ---- to Items, with visible buffers for unexplained gaps
  const evs = [...prefix, ...sim.evs].sort((a, b) => a.start - b.start || a.end - b.end);
  const withGaps: Ev[] = [];
  for (const e of evs) {
    const prev = withGaps.at(-1);
    if (prev && e.start - prev.end >= MIN_GAP_ITEM) {
      withGaps.push({ type: "free_time", start: prev.end, end: e.start, title: "Buffer / at leisure", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
    }
    withGaps.push(e);
  }

  const items: Item[] = withGaps.map((e, i) => ({
    id: `d${frame.dayNumber}-${i + 1}`,
    type: e.type,
    startTime: fromMin(e.start),
    endTime: fromMin(e.end),
    refId: e.refId,
    title: e.title,
    locked: false,
    source: e.type === "activity" ? args.source ?? "planner" : "planner",
    whySelected: e.type === "activity" && e.refId ? whyFor(e.refId) : [],
    tradeoffs: [...e.tradeoffs, ...(e.refId ? args.tradeoffs?.[e.refId] ?? [] : [])],
    narration: null,
    ...(e.transfer ? { transfer: e.transfer } : {}),
    costINR: e.cost,
  }));

  function whyFor(refId: string): string[] {
    if (args.reasons?.[refId]?.length) return args.reasons[refId];
    const p = pool.pois.find((x) => x.id === refId);
    return p ? p.scoreParts.filter((s) => s.value > 0).map((s) => s.label) : [];
  }

  // Requested far day trips get a transit allowance so the validator doesn't reject what the user asked for.
  let dayTripTransitAllowanceMin = 0;
  for (const id of itemIds) {
    const p = pool.pois.find((x) => x.id === id);
    if (p?.isDayTrip && p.requested) {
      dayTripTransitAllowanceMin = Math.max(dayTripTransitAllowanceMin, 2 * taxiMinutes(haversineKm(hotelLoc, p.poi), cityId).minutes + 60);
    }
  }

  const totals = {
    walkKm: round1(withGaps.reduce((s, e) => s + e.walkKm, 0)),
    transitMin: withGaps.reduce((s, e) => s + e.transitMin, 0),
    costINR: withGaps.reduce((s, e) => s + e.cost, 0),
  };
  return t.finish(
    { frame, items, dropped: sim.dropped, penalties: roundAll(sim.penalties), totals, dayTripTransitAllowanceMin },
    { items: items.length, dropped: sim.dropped.map((d) => d.refId), totals },
  );
}

function greedyOrder(stops: Stop[], start: LatLng): Stop[] {
  // Nearest-neighbour from the hotel; lunch goes in after roughly half the places.
  const acts = stops.filter((s): s is Extract<Stop, { kind: "activity" }> => s.kind === "activity");
  const out: Stop[] = [];
  let pos = start;
  while (acts.length) {
    acts.sort((a, b) => haversineKm(pos, a.loc) - haversineKm(pos, b.loc));
    const next = acts.shift()!;
    out.push(next);
    pos = next.loc;
  }
  if (stops.some((s) => s.kind === "lunch")) out.splice(Math.ceil(out.length / 2), 0, { kind: "lunch" });
  return out;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const roundAll = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
