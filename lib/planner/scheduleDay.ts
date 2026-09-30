/**
 * Stage 6 — turn a day's assigned places into a timed itinerary.
 *
 * Each candidate ordering is fully simulated (travel, opening hours, fixed start
 * times, lunch, rest breaks, evening, dinner and return to the hotel) and costed
 * as travel minutes + weighted soft penalties + large penalties for anything
 * that would fail validation. Lunch is itself a stop in the ordering, so the
 * search can choose between e.g. "lunch first" and "late lunch after the caves".
 * With ≤ 7 places we try every ordering (≤ 8! = 40,320 simulations — a few ms
 * each); beyond that, greedy nearest-neighbour.
 *
 * scheduleDayBest adds one more option for long day-trip days: starting earlier
 * than dayStart (never before EARLIEST_OVERRIDE_START) when the normal start
 * would mean a late lunch, a late return or a dropped sight.
 */
import type { Item, ItemType, Levers, StageResult, Tier } from "../types";
import { haversineKm, type LatLng, localLeg, round1, taxiMinutes } from "./geo";
import type { CandidatePool, DayFrame, HotelBase, PlannerContext, ScheduledDay } from "./plannerTypes";
import { fromMin, overlapMin, toMin } from "./time";
import { startTrace } from "./trace";
import { ASSUMED, gatewayWord } from "./transfers";

const MAX_PERMUTE = 7;
const REST_MIN = 15;
const MEAL_FALLBACK_MIN = 60;
const MAX_RESTAURANT_KM = 5; // further than this, suggest "somewhere local" instead
const REPEAT_RESTAURANT_KM = 3; // each earlier visit makes a restaurant count as this much further away
const MIN_GAP_ITEM = 10; // gaps shorter than this aren't worth showing
const TAXI_INR_PER_KM = 20;
/** Airport/station taxi when only minutes are known: ~30 km/h × ₹20/km. */
const TAXI_INR_PER_MIN = 10;
const CHECKOUT_MIN = 15;
const MEAL_INR_PER_PERSON: Record<Tier, number> = { budget: 250, mid: 600, premium: 1500 };
const EARLY_START_STEP_MIN = 30;
/** A hard meal window still tolerates starting this late (nobody minds lunch at 14:31). */
export const MEAL_GRACE_MIN = 15;

/** Soft penalty weights (in "minutes of travel" equivalents). */
const W = {
  waitingPerMin: 0.5,
  lunchWaitPerMin: 0.25,
  timeOfDayMismatch: 30,
  avoidPerMin: 1,
  crowded: 20,
  lateMealPerMin: 1,
  freeTimeShortPerMin: 0.5,
  walkingPerKm: 60, // only when minimising walking (repair "reorder")
  skipped: 1000,
  hard: 500, // anything the validator would reject: hard meal windows, late return
};

type Loc = LatLng & { name: string };
type ActivityStop = {
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
  priceSource: string;
  crowded: boolean;
  variantName: string | null;
};
type Stop = ActivityStop | { kind: "lunch" };

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
  costBasis?: string;
  assumed?: boolean;
};

type SimResult = {
  evs: Ev[];
  cost: number;
  penalties: Record<string, number>;
  dropped: { refId: string; reason: string }[];
  departure: ScheduledDay["departure"];
};

export type ScheduleArgs = {
  frame: DayFrame;
  itemIds: string[];
  pool: CandidatePool;
  levers: Levers;
  hotel: HotelBase;
  ctx: PlannerContext;
  forceTaxi?: boolean;
  /** Repair "reorder": weigh walking heavily when choosing the order. */
  minimizeWalking?: boolean;
  /** POIs to do as their lighter variant (set by repair). */
  variantIds?: Set<string>;
  /** How often each restaurant is already used on other days (for variety). */
  restaurantUse?: Map<string, number>;
  reasons?: Record<string, string[]>;
  tradeoffs?: Record<string, string[]>;
  source?: Item["source"];
};

export function scheduleDay(args: ScheduleArgs): StageResult<ScheduledDay> {
  const { frame, itemIds, pool, levers, hotel, ctx } = args;
  const t = startTrace(`scheduleDay:${frame.dayNumber}`, {
    date: frame.date, weekday: frame.weekday, start: fromMin(frame.startMin), itemIds,
    forceTaxi: !!args.forceTaxi, minimizeWalking: !!args.minimizeWalking,
  });
  const cityId = frame.cityId;
  const hotelLoc: Loc = { lat: hotel.area.lat, lng: hotel.area.lng, name: `hotel (${hotel.area.name})` };
  const cars = Math.ceil(ctx.pax / 4);
  const rooms = Math.ceil(ctx.pax / 2);
  const lunch = { start: toMin(levers.lunchWindow.start), end: toMin(levers.lunchWindow.end) };
  const dinner = { start: toMin(levers.dinnerWindow.start), end: toMin(levers.dinnerWindow.end) };
  const returnBy = toMin(levers.returnByLatest);
  const restEvery = levers.restBreakEveryMin;
  const use = args.restaurantUse ?? new Map<string, number>();

  // ---- build stops
  const stops: ActivityStop[] = [];
  for (const id of itemIds) {
    const p = pool.pois.find((x) => x.id === id);
    if (p) {
      const forced = args.variantIds?.has(id) && !p.variant ? p.poi.variants?.[0] ?? null : null;
      const variant = forced ?? p.variant;
      const acc = forced ? { ...p.accessibility, ...forced.accessibility } : p.accessibility;
      stops.push({
        kind: "activity",
        refId: id,
        title: variant ? `${p.poi.name} — ${variant.name.replace(/^.*?–\s*/, "")}` : p.poi.name,
        loc: { lat: p.poi.lat, lng: p.poi.lng, name: p.poi.name },
        durationMin: forced ? Math.round(forced.durationMin.typical * levers.durationMultiplier) : p.durationMin,
        openRanges: p.poi.openingHours[frame.weekday as keyof typeof p.poi.openingHours].map(([o, c]) => [toMin(o), toMin(c)]),
        fixedStarts: null,
        bestTimeOfDay: p.poi.bestTimeOfDay,
        avoid: p.poi.avoidTimes.map((w) => [toMin(w.start), toMin(w.end)]),
        walkM: acc.walkingRequiredM,
        flat: acc.terrain === "flat",
        priceINR: p.poi.priceINR,
        priceSource: `catalogue, ${p.poi.provenance.source} ${p.poi.provenance.confidence}`,
        crowded: frame.crowdedPoiIds.includes(id),
        variantName: variant?.name ?? null,
      });
      continue;
    }
    const x = pool.experiences.find((e) => e.id === id);
    if (x) {
      const operates = x.experience.daysOperating.includes(frame.weekday as never);
      const linked = pool.pois.find((pp) => x.experience.linkedPoiIds.includes(pp.id))?.poi;
      // Tours with transport pick you up at the hotel.
      const loc = x.experience.includesTransport || !linked ? { ...hotelLoc, name: x.experience.name } : { lat: linked.lat, lng: linked.lng, name: x.experience.name };
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
        priceSource: `experience catalogue, ${x.experience.provenance.source} ${x.experience.provenance.confidence}`,
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
  /** Nearest suitable restaurant, nudged away from ones used on other days; never one already used today. */
  const pickRestaurant = (from: LatLng, meal: "lunch" | "dinner", usedToday: Set<string>) => {
    const effKm = (r: { id: string }, km: number) => km + REPEAT_RESTAURANT_KM * (use.get(r.id) ?? 0);
    const options = pool.restaurants
      .filter((r) => r.mealTypes.includes(meal) && !usedToday.has(r.id))
      .map((r) => ({ r, km: haversineKm(from, r) }))
      .filter((o) => o.km <= MAX_RESTAURANT_KM)
      .sort((a, b) => effKm(a.r, a.km) - effKm(b.r, b.km));
    return options[0]?.r ?? null;
  };
  const mealCost = (band: Tier) => MEAL_INR_PER_PERSON[band] * ctx.pax;
  const mealBasis = (band: Tier, known: boolean) =>
    `${ctx.pax} × ₹${MEAL_INR_PER_PERSON[band]} (${band} band, planner rate${known ? "" : "; restaurant not in catalogue"})`;

  function earliestStart(s: ActivityStop, arrive: number): number | null {
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
    const pen: Record<string, number> = {
      travel: 0, waiting: 0, timeOfDay: 0, avoidTimes: 0, crowd: 0, lateMeal: 0, freeTimeShort: 0,
      walking: 0, skipped: 0, hardMeal: 0, lateReturn: 0,
    };
    const dropped: SimResult["dropped"] = [];
    const usedToday = new Set<string>();
    let time = frame.startMin;
    let pos: Loc = hotelLoc;
    let sinceRest = 0;
    let pendingBuffer = 0; // slack after a visit; a meal absorbs it
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
          costBasis: taxi ? `₹${TAXI_INR_PER_KM}/km × ${leg.km} km × ${cars} car(s), planner rate` : undefined,
          walkKm: taxi ? 0 : leg.km, transitMin: taxi ? leg.minutes : 0, tradeoffs: [],
        });
        pen.travel += leg.minutes;
        if (!taxi && args.minimizeWalking) pen.walking += leg.km * W.walkingPerKm;
      }
      pos = to;
      return at + leg.minutes;
    };

    const eatAt = (meal: "lunch" | "dinner", from: LatLng) => {
      const r = pickRestaurant(from, meal, usedToday);
      if (r) usedToday.add(r.id);
      return r;
    };

    for (const s of order) {
      if (s.kind === "lunch") {
        pendingBuffer = 0;
        const r = eatAt("lunch", pos);
        const loc: Loc = r ? { lat: r.lat, lng: r.lng, name: r.name } : pos;
        const leg = localLeg(pos, loc, cityId, levers, { flatTerrain: true, forceTaxi: args.forceTaxi });
        const start = Math.max(time + leg.minutes, lunch.start);
        const tradeoffs: string[] = [];
        if (start > lunch.end) {
          pen.lateMeal += (start - lunch.end) * W.lateMealPerMin;
          if (levers.mealWindowsHard && start > lunch.end + MEAL_GRACE_MIN) pen.hardMeal += W.hard;
          tradeoffs.push(`Late lunch${lastActivity ? ` so ${lastActivity} fits its opening hours` : ""}`);
        }
        pen.waiting += (start - time - leg.minutes) * W.lunchWaitPerMin;
        go(loc, true, time);
        const dur = r?.avgMealMin ?? MEAL_FALLBACK_MIN;
        evs.push({
          type: "meal", start, end: start + dur, refId: r?.id ?? null, tradeoffs,
          title: r ? `Lunch at ${r.name}` : `Lunch near ${pos.name} (local restaurant)`,
          cost: mealCost(r?.priceBand ?? ctx.budgetTier), costBasis: mealBasis(r?.priceBand ?? ctx.budgetTier, !!r), walkKm: 0, transitMin: 0,
        });
        time = start + dur;
        sinceRest = 0;
        continue;
      }

      time += pendingBuffer;
      pendingBuffer = 0;
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
        costBasis: s.priceINR ? `${ctx.pax} × ₹${s.priceINR} entry (${s.priceSource})` : `free entry (${s.priceSource})`,
        tradeoffs: s.variantName ? [`Doing "${s.variantName}" rather than the full visit to keep walking/stairs manageable`] : [],
      });
      sinceRest += s.durationMin + (leg.mode === "walk" ? leg.minutes : 0);
      lastActivity = s.title;
      time = end;
      pendingBuffer = Math.round(levers.bufferPct * s.durationMin);
    }

    // ---- end of day
    let departure: SimResult["departure"] = null;
    if (frame.isDeparture && frame.departure) {
      const dep = frame.departure;
      const atHotel = go(hotelLoc, true, time);
      const word = dep.mode === "road" ? "" : gatewayWord(dep.mode);
      // Leave the hotel just in time to be at the airport/station `leadMin` before departure.
      const leaveBy = dep.depMin - dep.leadMin - dep.accessMin;
      const checkout = Math.max(atHotel, leaveBy - CHECKOUT_MIN);
      if (checkout - atHotel >= MIN_GAP_ITEM) {
        evs.push({ type: "free_time", start: atHotel, end: checkout, title: "Free time / rest at hotel (late checkout)", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
      }
      evs.push({ type: "hotel", start: checkout, end: checkout + CHECKOUT_MIN, title: `Collect bags and check out of ${hotel.area.name}`, refId: hotel.area.id, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
      const leave = checkout + CHECKOUT_MIN;
      let atGateway = leave;
      if (dep.mode !== "road") {
        atGateway = leave + dep.accessMin;
        evs.push({
          type: "transfer", start: leave, end: atGateway, title: `Taxi to ${dep.cityName} ${word}`, refId: null,
          transfer: { mode: "auto_taxi", distanceKm: 0 }, cost: dep.accessMin * TAXI_INR_PER_MIN * cars,
          costBasis: `~${dep.accessMin} min × ₹${TAXI_INR_PER_MIN}/min × ${cars} car(s), planner rate`, walkKm: 0, transitMin: dep.accessMin, tradeoffs: [], assumed: true,
        });
        if (atGateway < dep.depMin) {
          evs.push({ type: "free_time", start: atGateway, end: dep.depMin, title: dep.mode === "flight" ? "Check-in & security" : "At the station", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [], assumed: true });
        }
      }
      if (atGateway > dep.depMin - dep.leadMin) pen.lateReturn += W.hard + (atGateway - (dep.depMin - dep.leadMin));
      evs.push({
        type: "transfer", start: dep.depMin, end: dep.depMin, refId: null, cost: 0, walkKm: 0, transitMin: 0, assumed: true,
        title: dep.mode === "road" ? `Depart ${dep.cityName} by car ~${fromMin(dep.depMin)} ${ASSUMED}` : `${dep.mode === "flight" ? "Flight" : "Train"} departs ${dep.cityName} ${fromMin(dep.depMin)} ${ASSUMED}`,
        tradeoffs: dep.mode === "road" ? [] : [`Be at the ${word} ${dep.leadMin} min before departure`],
      });
      departure = { depMin: dep.depMin, atGatewayMin: atGateway, leadMin: dep.leadMin };
    } else if (frame.isDeparture) {
      time = go(hotelLoc, true, time);
      evs.push({ type: "transfer", start: time, end: time, title: `Collect bags and depart ${cityId}`, refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
    } else {
      const atHotel = go(hotelLoc, true, time);
      const r = eatAt("dinner", hotelLoc);
      const dLoc: Loc = r ? { lat: r.lat, lng: r.lng, name: r.name } : hotelLoc;
      const legMin = localLeg(hotelLoc, dLoc, cityId, levers, { flatTerrain: true, forceTaxi: args.forceTaxi }).minutes;
      const dur = r?.avgMealMin ?? MEAL_FALLBACK_MIN;
      // Ideal: full free time, dinner in its window, back by returnByLatest.
      let dinnerStart = Math.max(dinner.start, atHotel + levers.freeTimeMin + legMin);
      dinnerStart = Math.min(dinnerStart, dinner.end, returnBy - dur - legMin);
      dinnerStart = Math.max(dinnerStart, atHotel + legMin); // can't eat before getting there
      const leave = dinnerStart - legMin;
      const free = leave - atHotel;
      if (free < levers.freeTimeMin) pen.freeTimeShort += (levers.freeTimeMin - free) * W.freeTimeShortPerMin;
      if (free >= MIN_GAP_ITEM) {
        evs.push({ type: "free_time", start: atHotel, end: leave, title: "Free time / rest at hotel", refId: null, cost: 0, walkKm: 0, transitMin: 0, tradeoffs: [] });
      }
      go(dLoc, true, leave);
      const dinnerTradeoffs: string[] = [];
      if (dinnerStart > dinner.end) {
        pen.lateMeal += (dinnerStart - dinner.end) * W.lateMealPerMin;
        if (levers.mealWindowsHard && dinnerStart > dinner.end + MEAL_GRACE_MIN) pen.hardMeal += W.hard;
        dinnerTradeoffs.push("Later dinner than you'd like, because of the long day");
      }
      evs.push({
        type: "meal", start: dinnerStart, end: dinnerStart + dur, refId: r?.id ?? null, tradeoffs: dinnerTradeoffs,
        title: r ? `Dinner at ${r.name}` : "Dinner near hotel (local restaurant)",
        cost: mealCost(r?.priceBand ?? ctx.budgetTier), costBasis: mealBasis(r?.priceBand ?? ctx.budgetTier, !!r), walkKm: 0, transitMin: 0,
      });
      const back = go(hotelLoc, true, dinnerStart + dur);
      if (back > returnBy) pen.lateReturn += W.hard + (back - returnBy);
      evs.push({
        type: "hotel", start: back, end: back, title: `Overnight at ${hotel.area.name}`, refId: hotel.area.id,
        cost: hotel.area.hotelPriceBand[ctx.budgetTier] * rooms, walkKm: 0, transitMin: 0, tradeoffs: [],
        costBasis: `${rooms} room(s) × ₹${hotel.area.hotelPriceBand[ctx.budgetTier]} (${hotel.area.name} ${ctx.budgetTier} band, cities.json ai_draft)`,
      });
    }

    const cost = Object.values(pen).reduce((a, b) => a + b, 0);
    return { evs, cost, penalties: pen, dropped, departure };
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
    const { hop, segments } = frame.transfer;
    const mid = Math.round((hop.edge.fareBandINR.min + hop.edge.fareBandINR.max) / 2);
    const perCar = hop.edge.mode === "road";
    for (const seg of segments) {
      const notes: string[] = [];
      let cost = 0;
      let costBasis: string | undefined;
      if (seg.kind === "in_vehicle") {
        notes.push(`Leaves the hotel at your usual start (${levers.dayStart}); times assume that`);
        if (frame.transfer.endMin > frame.endMin) notes.push(`Arrives after your usual day end (${levers.dayEnd}); an earlier departure would help`);
        if (hop.alternatives.length) notes.push(`Alternatives: ${hop.alternatives.join(", ")}`);
        cost = mid * (perCar ? cars : ctx.pax);
        costBasis = `fare band ₹${hop.edge.fareBandINR.min}–${hop.edge.fareBandINR.max} midpoint × ${perCar ? `${cars} car(s)` : `${ctx.pax} people`} (edges.json, ai_draft)`;
      } else if (seg.kind === "to_gateway" || seg.kind === "from_gateway") {
        cost = (seg.end - seg.start) * TAXI_INR_PER_MIN * cars;
        costBasis = `~${seg.end - seg.start} min × ₹${TAXI_INR_PER_MIN}/min × ${cars} car(s), planner rate`;
      }
      prefix.push({
        type: seg.kind === "at_gateway" ? "free_time" : "transfer", start: seg.start, end: seg.end, title: seg.title, refId: null,
        transfer: seg.kind === "in_vehicle" ? { mode: hop.edge.mode, distanceKm: 0 } : seg.kind === "at_gateway" ? undefined : { mode: "auto_taxi", distanceKm: 0 },
        cost, costBasis, walkKm: 0, transitMin: 0, tradeoffs: notes, assumed: true,
      });
    }
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
    ...(e.cost ? { costBasis: e.costBasis } : {}),
    ...(e.assumed ? { assumed: true } : {}),
  }));

  function whyFor(refId: string): string[] {
    if (args.reasons?.[refId]?.length) return args.reasons[refId];
    const p = pool.pois.find((x) => x.id === refId);
    return p ? p.scoreParts.filter((s) => s.value > 0).map((s) => s.label) : [];
  }

  // Requested day trips get a transit allowance so the validator doesn't reject what the user asked for.
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
    { frame, items, dropped: sim.dropped, penalties: roundAll(sim.penalties), totals, dayTripTransitAllowanceMin, startOverride: null, departure: sim.departure },
    { items: items.length, dropped: sim.dropped.map((d) => d.refId), totals },
  );
}

/** How bad the timing is: dropped sights ≫ validator failures (hard meals, late return) ≫ soft late meals. */
const timingSeverity = (d: ScheduledDay) =>
  d.dropped.length * 1e6 + ((d.penalties.hardMeal ?? 0) + (d.penalties.lateReturn ?? 0)) * 1e3 + (d.penalties.lateMeal ?? 0);
const hasTimingProblems = (d: ScheduledDay) => timingSeverity(d) > 0;

/**
 * Schedule a day; if it holds a day trip and the normal start causes timing
 * problems, try starting earlier in 30-minute steps (down to the frame's
 * earliestStartMin) and keep the latest start that fixes them.
 */
export function scheduleDayBest(args: ScheduleArgs): StageResult<ScheduledDay> {
  const base = scheduleDay(args);
  const { frame, pool } = args;
  const hasDayTrip = args.itemIds.some((id) => pool.pois.find((p) => p.id === id)?.isDayTrip);
  if (!hasDayTrip || frame.earliestStartMin >= frame.startMin || !hasTimingProblems(base.result)) return base;

  let best = base;
  for (let start = frame.startMin - EARLY_START_STEP_MIN; start >= frame.earliestStartMin; start -= EARLY_START_STEP_MIN) {
    const earlier = scheduleDay({ ...args, frame: { ...frame, startMin: start, capacityMin: frame.capacityMin + (frame.startMin - start) } });
    if (!hasTimingProblems(earlier.result)) { best = earlier; break; }
    // Nothing fully clean yet: keep the least-bad start (later start wins ties).
    if (timingSeverity(earlier.result) < timingSeverity(best.result)) best = earlier;
  }
  if (best === base) {
    base.trace.decisions.push({ what: "kept normal start", why: `starting as early as ${fromMin(frame.earliestStartMin)} doesn't help` });
    return base;
  }

  const from = frame.startMin;
  const to = best.result.frame.startMin;
  const note = `Starts at ${fromMin(to)} instead of ${fromMin(from)} so lunch and return aren't late`;
  const first = best.result.items.find((i) => i.type !== "hotel") ?? best.result.items[0];
  if (first) first.tradeoffs.unshift(note);
  best.result.startOverride = { fromMin: from, toMin: to };
  best.trace.decisions.unshift({ what: `early start ${fromMin(to)}`, why: `normal ${fromMin(from)} start caused late meals/return or a dropped sight` });
  return best;
}

function greedyOrder(stops: Stop[], start: LatLng): Stop[] {
  // Nearest-neighbour from the hotel; lunch goes in after roughly half the places.
  const acts = stops.filter((s): s is ActivityStop => s.kind === "activity");
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

const roundAll = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
