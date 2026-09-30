/**
 * Stage 7 — validate the scheduled days, then repair what fails.
 *
 * Hard checks are facts that make a plan wrong (closed site, overlapping
 * times, over the walking limit). Soft scores describe quality (pace, budget,
 * interest mix) and are reported, not enforced.
 *
 * Repair works on day *states* (assigned IDs + options) and re-runs the
 * scheduler, trying in order: walk→taxi and reorder (walking problems only),
 * lighter variant, move an item to a
 * day with room, drop the lowest-priority item. Max 2 passes.
 */
import type { City, Constraint, Levers, StageResult, Tier } from "../types";
import { interestTags, ofType } from "./constraints";
import type { CandidatePool, DayFrame, PlannerContext, ScheduledDay } from "./plannerTypes";
import { MEAL_GRACE_MIN } from "./scheduleDay";
import { toMin } from "./time";
import { startTrace } from "./trace";

export type ViolationRule =
  | "closed" | "overlap" | "outside_window" | "walk_km" | "transit" | "duplicate" | "anchor" | "unscheduled"
  | "late_return" | "meal_window" | "restaurant_repeat";
export type Violation = { dayNumber: number; rule: ViolationRule; refId?: string; detail: string };
export type ValidationReport = {
  ok: boolean;
  hard: Violation[];
  soft: {
    pace: { dayNumber: number; majorItems: number; maxMajorItems: number; overLimit: boolean }[];
    /** Restaurants used on more than one day (allowed, but less varied). */
    restaurantRepeats: { restaurantId: string; days: number[] }[];
    budget: { estimatedINR: number; tierBenchmarkINR: number; ratio: number; capINR: number | null; overCap: boolean };
    interestMix: { matched: number; total: number; share: number };
  };
};

type ValidateCtx = { levers: Levers; constraints: Constraint[]; pools: Map<string, CandidatePool>; ctx: PlannerContext; cities: City[] };

export function validatePlan(days: ScheduledDay[], v: ValidateCtx): StageResult<ValidationReport> {
  const t = startTrace("validatePlan", { days: days.length });
  const { levers, constraints, pools, ctx } = v;
  const hard: Violation[] = [];
  const seen = new Map<string, number>();

  for (const day of days) {
    const f = day.frame;
    const pool = pools.get(f.cityId)!;
    const acts = day.items.filter((i) => i.type === "activity");

    for (const d of day.dropped) hard.push({ dayNumber: f.dayNumber, rule: "unscheduled", refId: d.refId, detail: d.reason });

    // Overlaps (zero-length markers like "Overnight" can't overlap).
    const sorted = [...day.items].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (toMin(sorted[i].startTime) < toMin(sorted[i - 1].endTime)) {
        hard.push({ dayNumber: f.dayNumber, rule: "overlap", refId: sorted[i].refId ?? undefined, detail: `"${sorted[i].title}" starts before "${sorted[i - 1].title}" ends` });
      }
    }

    for (const a of acts) {
      const s = toMin(a.startTime), e = toMin(a.endTime);
      const id = a.refId!;
      // Open at the scheduled time?
      const p = pool.pois.find((x) => x.id === id);
      const x = pool.experiences.find((y) => y.id === id);
      if (p) {
        const ranges = p.poi.openingHours[f.weekday as keyof typeof p.poi.openingHours];
        if (!ranges.some(([o, c]) => s >= toMin(o) && e <= toMin(c))) {
          hard.push({ dayNumber: f.dayNumber, rule: "closed", refId: id, detail: `${p.poi.name} not open ${a.startTime}–${a.endTime} on ${f.weekday}` });
        }
      } else if (x) {
        if (!x.experience.daysOperating.includes(f.weekday as never) || !x.experience.startTimes.includes(a.startTime)) {
          hard.push({ dayNumber: f.dayNumber, rule: "closed", refId: id, detail: `${x.experience.name} doesn't start at ${a.startTime} on ${f.weekday}` });
        }
      }
      if (s < f.startMin || e > f.endMin) {
        hard.push({ dayNumber: f.dayNumber, rule: "outside_window", refId: id, detail: `${a.title} ${a.startTime}–${a.endTime} outside the day's sightseeing window` });
      }
      if (seen.has(id)) hard.push({ dayNumber: f.dayNumber, rule: "duplicate", refId: id, detail: `${a.title} already on day ${seen.get(id)}` });
      else seen.set(id, f.dayNumber);
    }

    // Back at the hotel in time (the zero-length "Overnight" marker is the return time).
    const overnight = day.items.find((i) => i.type === "hotel" && i.title.startsWith("Overnight"));
    if (overnight && toMin(overnight.startTime) > toMin(levers.returnByLatest)) {
      hard.push({ dayNumber: f.dayNumber, rule: "late_return", detail: `back at hotel ${overnight.startTime}, after ${levers.returnByLatest}` });
    }

    // Meals: never the same place twice in a day; inside their windows when those are hard.
    const meals = day.items.filter((i) => i.type === "meal");
    const mealIds = meals.map((m) => m.refId).filter((id): id is string => !!id);
    if (new Set(mealIds).size < mealIds.length) {
      hard.push({ dayNumber: f.dayNumber, rule: "restaurant_repeat", detail: "lunch and dinner at the same restaurant" });
    }
    if (levers.mealWindowsHard) {
      for (const m of meals) {
        const w = m.title.startsWith("Lunch") ? levers.lunchWindow : levers.dinnerWindow;
        if (toMin(m.startTime) < toMin(w.start) || toMin(m.startTime) > toMin(w.end) + MEAL_GRACE_MIN) {
          hard.push({ dayNumber: f.dayNumber, rule: "meal_window", detail: `${m.title} at ${m.startTime}, outside ${w.start}–${w.end}` });
        }
      }
    }

    if (day.totals.walkKm > levers.maxWalkKmPerDay) {
      hard.push({ dayNumber: f.dayNumber, rule: "walk_km", detail: `${day.totals.walkKm} km walking > ${levers.maxWalkKmPerDay} km` });
    }
    const transitLimit = Math.max(levers.maxTransitMinPerDay, day.dayTripTransitAllowanceMin);
    if (day.totals.transitMin > transitLimit) {
      hard.push({ dayNumber: f.dayNumber, rule: "transit", detail: `${day.totals.transitMin} min local transit > ${transitLimit} min` });
    }
    if (day.dayTripTransitAllowanceMin > levers.maxTransitMinPerDay) {
      t.decide(`day ${f.dayNumber} transit allowance ${transitLimit} min`, "requested day trip needs more driving than the usual daily limit");
    }
  }

  for (const c of ofType(constraints, "date_anchor")) {
    if (!c.params.poiId) continue;
    const day = days.find((d) => d.frame.date === c.params.date);
    if (day && !day.items.some((i) => i.refId === c.params.poiId)) {
      hard.push({ dayNumber: day.frame.dayNumber, rule: "anchor", refId: c.params.poiId, detail: `${c.params.poiId} was requested on ${c.params.date}` });
    }
  }

  // ---- soft scores
  const pace = days.map((d) => {
    const majorItems = d.items.filter((i) => i.type === "activity").length;
    return { dayNumber: d.frame.dayNumber, majorItems, maxMajorItems: d.frame.maxMajorItems, overLimit: majorItems > d.frame.maxMajorItems };
  });

  const estimatedINR = days.reduce((s, d) => s + d.totals.costINR, 0);
  const tierBenchmarkINR = days.reduce((s, d) => {
    const city = v.cities.find((c) => c.id === d.frame.cityId)!;
    return s + city.avgDailyCostByTier[ctx.budgetTier as Tier] * ctx.pax + hotelCost(d);
  }, 0);
  const cap = ofType(constraints, "budget_cap").find((c) => c.params.per === "trip")?.params.amountINR ?? null;

  const liked = interestTags(constraints).like;
  const allActs = days.flatMap((d) => d.items.filter((i) => i.type === "activity"));
  const matched = allActs.filter((a) => {
    const p = pools.get(days.find((d) => d.items.includes(a))!.frame.cityId)!.pois.find((x) => x.id === a.refId);
    return p && [...p.poi.interestTags, p.poi.category].some((tag) => liked.has(tag));
  }).length;

  const restaurantDays = new Map<string, number[]>();
  for (const d of days) {
    for (const m of d.items.filter((i) => i.type === "meal" && i.refId)) {
      restaurantDays.set(m.refId!, [...new Set([...(restaurantDays.get(m.refId!) ?? []), d.frame.dayNumber])]);
    }
  }
  const restaurantRepeats = [...restaurantDays].filter(([, ds]) => ds.length > 1).map(([restaurantId, ds]) => ({ restaurantId, days: ds }));

  const report: ValidationReport = {
    ok: hard.length === 0,
    hard,
    soft: {
      pace,
      restaurantRepeats,
      budget: { estimatedINR, tierBenchmarkINR, ratio: round2(estimatedINR / Math.max(1, tierBenchmarkINR)), capINR: cap, overCap: cap !== null && estimatedINR > cap },
      interestMix: { matched, total: allActs.length, share: allActs.length ? round2(matched / allActs.length) : 0 },
    },
  };
  for (const h of hard) t.decide(`day ${h.dayNumber}: ${h.rule}`, h.detail);
  return t.finish(report, { hard: hard.length, budgetRatio: report.soft.budget.ratio, interestShare: report.soft.interestMix.share });
}

const hotelCost = (d: ScheduledDay) => d.items.filter((i) => i.type === "hotel").reduce((s, i) => s + (i.costINR ?? 0), 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

export type DayState = {
  frame: DayFrame;
  itemIds: string[];
  forceTaxi: boolean;
  minimizeWalking: boolean;
  variantIds: Set<string>;
  reasons: Record<string, string[]>;
  tradeoffs: Record<string, string[]>;
};
export type RepairAction = { pass: number; dayNumber: number; strategy: "walk_to_taxi" | "reorder" | "variant" | "move" | "drop"; refId?: string; detail: string; accepted: boolean };

const MAX_PASSES = 2;

export function repairPlan(args: {
  states: DayState[];
  schedule: (s: DayState) => ScheduledDay;
  validate: (days: ScheduledDay[]) => ValidationReport;
  pools: Map<string, CandidatePool>;
  /** Extra placement rule for moves (e.g. only light items onto light travel days). */
  canPlace?: (refId: string, target: DayState) => boolean;
}): StageResult<{ states: DayState[]; days: ScheduledDay[]; report: ValidationReport; actions: RepairAction[]; warnings: string[] }> {
  const t = startTrace("repairPlan", { days: args.states.length });
  let states = args.states.map(clone);
  let days = states.map(args.schedule);
  let report = args.validate(days);
  const actions: RepairAction[] = [];
  const warnings: string[] = [];
  const countFor = (r: ValidationReport, dayNumbers: number[]) => r.hard.filter((h) => dayNumbers.includes(h.dayNumber)).length;

  /** Apply a change to some days; keep it only if their violation count drops. */
  const attempt = (pass: number, dayNumber: number, strategy: RepairAction["strategy"], refId: string | undefined, detail: string, mutate: (s: DayState[]) => number[] | null, mustImprove = true) => {
    const trial = states.map(clone);
    const touched = mutate(trial);
    if (!touched) return false;
    const trialDays = days.map((d, i) => (touched.includes(trial[i].frame.dayNumber) ? args.schedule(trial[i]) : d));
    const trialReport = args.validate(trialDays);
    const better = countFor(trialReport, touched) < countFor(report, touched) || (!mustImprove && countFor(trialReport, touched) <= countFor(report, touched));
    actions.push({ pass, dayNumber, strategy, refId, detail, accepted: better });
    t.decide(`${better ? "accepted" : "rejected"} ${strategy} on day ${dayNumber}`, detail);
    if (better) {
      states = trial;
      days = trialDays;
      report = trialReport;
    }
    return better;
  };

  for (let pass = 1; pass <= MAX_PASSES && !report.ok; pass++) {
    const badDays = [...new Set(report.hard.map((h) => h.dayNumber))];
    for (const dayNumber of badDays) {
      const idx = states.findIndex((s) => s.frame.dayNumber === dayNumber);
      const pool = args.pools.get(states[idx].frame.cityId)!;
      const violations = () => report.hard.filter((h) => h.dayNumber === dayNumber);
      if (violations().length === 0) continue;

      const walkingProblem = () => violations().some((v) => v.rule === "walk_km");
      // Target: the item a violation names; for walking, the lowest-priority item that
      // actually involves walking; otherwise the lowest-priority item on the day.
      const target = (): string | undefined => {
        const named = violations().find((v) => v.refId && states[idx].itemIds.includes(v.refId))?.refId;
        if (named) return named;
        return [...states[idx].itemIds]
          .map((id) => ({ id, p: pool.pois.find((x) => x.id === id) }))
          .filter((x) => !x.p?.requested && (!walkingProblem() || (x.p?.accessibility.walkingRequiredM ?? 0) > 0))
          .sort((a, b) => (a.p?.score ?? 0) - (b.p?.score ?? 0))[0]?.id;
      };

      if (walkingProblem()) {
        // 1. walk → taxi for the legs between stops (short hops next door stay on foot)
        if (!states[idx].forceTaxi) {
          attempt(pass, dayNumber, "walk_to_taxi", undefined, "take autos/taxis between stops instead of walking", (s) => {
            s[idx].forceTaxi = true;
            return [dayNumber];
          });
        }
        // 2. reorder the day to minimise walking
        if (walkingProblem() && !states[idx].minimizeWalking) {
          attempt(pass, dayNumber, "reorder", undefined, "reorder stops to minimise walking", (s) => {
            s[idx].minimizeWalking = true;
            return [dayNumber];
          });
        }
      }
      if (violations().length === 0) continue;

      // 3. lighter variant (for walking: the stop with the most walking that has one)
      const vId = walkingProblem()
        ? states[idx].itemIds
            .map((id) => pool.pois.find((p) => p.id === id))
            .filter((p) => p && !p.variant && p.poi.variants?.length && !states[idx].variantIds.has(p.id))
            .sort((a, b) => b!.accessibility.walkingRequiredM - a!.accessibility.walkingRequiredM)[0]?.id
        : target();
      const vPoi = vId ? pool.pois.find((p) => p.id === vId) : undefined;
      if (vId && vPoi && !vPoi.variant && vPoi.poi.variants?.length && !states[idx].variantIds.has(vId)) {
        attempt(pass, dayNumber, "variant", vId, `switch ${vPoi.poi.name} to "${vPoi.poi.variants[0].name}"`, (s) => {
          s[idx].variantIds.add(vId);
          return [dayNumber];
        });
      }
      if (violations().length === 0) continue;

      // 4. move to another day in the same leg with room
      const mId = target();
      if (mId) {
        const others = states
          .map((s, i) => ({ s, i }))
          .filter(({ s, i }) => i !== idx && s.frame.cityId === states[idx].frame.cityId && !s.frame.closedPoiIds.includes(mId) && s.itemIds.length < s.frame.maxMajorItems)
          .filter(({ s }) => args.canPlace?.(mId, s) ?? !s.frame.lightOnly)
          .sort((a, b) => b.s.frame.capacityMin - a.s.frame.capacityMin);
        let moved = false;
        for (const { s: other, i: oi } of others) {
          moved = attempt(pass, dayNumber, "move", mId, `move ${mId} to day ${other.frame.dayNumber}`, (s) => {
            s[idx].itemIds = s[idx].itemIds.filter((x) => x !== mId);
            s[oi].itemIds.push(mId);
            s[oi].reasons[mId] = s[idx].reasons[mId] ?? [];
            (s[oi].tradeoffs[mId] ??= []).push(`Moved from day ${dayNumber} to fit opening hours/capacity`);
            return [dayNumber, other.frame.dayNumber];
          });
          if (moved) break;
        }
        if (moved && violations().length === 0) continue;
      }

      // 5. drop the lowest-priority item (never one the user explicitly asked for)
      const dId = target();
      const dPoi = dId ? pool.pois.find((p) => p.id === dId) : undefined;
      if (dId && !dPoi?.requested) {
        const reason = violations().map((v) => v.detail).join("; ");
        const ok = attempt(pass, dayNumber, "drop", dId, `drop ${dId}: ${reason}`, (s) => {
          s[idx].itemIds = s[idx].itemIds.filter((x) => x !== dId);
          return [dayNumber];
        }, false);
        if (ok) warnings.push(`Day ${dayNumber}: dropped ${dPoi?.poi.name ?? dId} (${reason}).`);
      }
    }
  }

  for (const h of report.hard) warnings.push(`Day ${h.dayNumber}: unresolved ${h.rule} — ${h.detail}`);
  return t.finish({ states, days, report, actions, warnings }, {
    actions: actions.map((a) => `p${a.pass} d${a.dayNumber} ${a.strategy}${a.refId ? ` ${a.refId}` : ""}: ${a.accepted ? "✓" : "✗"}`),
    remainingHard: report.hard.length,
  });
}

function clone(s: DayState): DayState {
  return {
    ...s,
    itemIds: [...s.itemIds],
    variantIds: new Set(s.variantIds),
    reasons: { ...s.reasons },
    tradeoffs: Object.fromEntries(Object.entries(s.tradeoffs).map(([k, v]) => [k, [...v]])),
  };
}
