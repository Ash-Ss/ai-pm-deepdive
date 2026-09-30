/**
 * AI day assignment (replaces assignDaysHeuristic when AI is on).
 *
 * The LLM gets compact tables (days + candidate pool) and returns which pool
 * IDs go on which day, with a theme and reasons. Code then:
 *   1. validates each day (IDs exist in that leg's pool, open that day, light
 *      days stay light, item limit, no duplicates, rough time capacity);
 *   2. retries once, feeding back the exact errors;
 *   3. rebalances over-full days (move lowest-priority items, else drop);
 *   4. falls back to the heuristic for any day that still fails.
 * sanitizeAssignment in the pipeline runs on top of this as a final guard.
 */
import { z } from "zod";
import { callLLM, type LLMMeta } from "../llm";
import { type AssignedDay, type AssignFn, type AssignInput, type AssignLeg, assignDaysHeuristic, isLightItem, type AssignOutput } from "../planner/assignDays";
import { travellerProfiles } from "../planner/constraints";
import { haversineKm, isFarDayTrip, taxiMinutes } from "../planner/geo";
import type { DayFrame } from "../planner/plannerTypes";
import { fromMin, toMin } from "../planner/time";

export const AIAssignOutput = z.object({
  days: z.array(z.object({
    dayIndex: z.number().int().positive().describe("the day number from the DAYS table"),
    theme: z.string().max(60).describe("2–6 words, e.g. 'Colonial Fort & museums'"),
    poiIds: z.array(z.string()),
    experienceIds: z.array(z.string()),
    whySelected: z.array(z.object({ id: z.string(), reasons: z.array(z.string().max(80)).max(3) })),
  })),
});
export type AIAssignOutput = z.infer<typeof AIAssignOutput>;

export const ASSIGN_SYSTEM = `You assign sightseeing to days for a Maharashtra trip. Return JSON only, matching the schema.
RULES
- Use ONLY ids from the POOL and EXPERIENCES tables of the same city as the day. Never invent ids or places.
- Every REQUESTED item must appear exactly once. Put must_see before worth_it before niche.
- Respect each day's "closed" list and "max items". Keep the sum of visit minutes (plus ~20 min travel between areas) within the day's capacity.
- Days marked LIGHT (arrival/travel) take only items marked "light".
- Items marked FULL-DAY take a whole day on their own.
- Group items in the same area on the same day. Put lighter days after travel days.
- No item on more than one day. Leaving a pool item out is fine.
- whySelected: 1–3 short reasons per chosen id, based only on the table (tier, tags, area, suitability).`;

// ---------------------------------------------------------------------------
// Prompt tables
// ---------------------------------------------------------------------------

function buildPrompt(input: AssignInput, locked: Record<number, string[]>, preferences: string[]): string {
  const profiles = travellerProfiles(input.constraints);
  const lines: string[] = [
    `TRAVELLERS: ${profiles.join(", ") || "not specified"}`,
    `PREFERENCES: ${preferences.join("; ") || "none"}`,
  ];
  for (const leg of input.legs) {
    lines.push(`\n=== CITY ${leg.cityId} (hotel area: ${leg.hotel.area.name}) ===`);
    lines.push("DAYS: day | date weekday | window | capacity min | energy | max items | flags | closed ids | locked ids");
    for (const f of leg.frames) {
      const flags = [f.lightOnly ? "LIGHT" : "", f.isTravel ? "travel" : "", f.isArrival ? "arrival" : "", f.isDeparture ? "departure" : "",
        f.earliestStartMin < f.startMin ? `may start ${fromMin(f.earliestStartMin)} for day trips` : ""].filter(Boolean).join(", ");
      lines.push(`${f.dayNumber} | ${f.date} ${f.weekday} | ${fromMin(f.startMin)}-${fromMin(f.endMin)} | ${f.capacityMin} | ${f.energy} | ${f.maxMajorItems} | ${flags || "-"} | ${f.closedPoiIds.join(",") || "-"} | ${(locked[f.dayNumber] ?? []).join(",") || "-"}`);
    }
    lines.push("POOL: id | name | area | category | visit min | tier | tags | suits kids/elderly/couples | best time | notes");
    for (const p of leg.pool.pois) {
      const km = haversineKm(leg.hotel.area, p.poi);
      const notes = [
        p.requested ? "REQUESTED" : "",
        isFarDayTrip(p.poi, leg.hotel.area) ? `FULL-DAY (~${taxiMinutes(km, leg.cityId).minutes} min drive each way)` : p.isDayTrip ? "day trip" : "",
        isLightItem(p, leg.hotel.area) ? "light" : "",
        p.variant ? `shorter version: ${p.variant.name}` : "",
      ].filter(Boolean).join(", ");
      const s = p.poi.suitability;
      lines.push(`${p.id} | ${p.poi.name} | ${p.poi.areaId} | ${p.poi.category} | ${p.durationMin} | ${p.poi.tier} | ${p.poi.interestTags.slice(0, 4).join(",")} | ${s.kids}/${s.elderly}/${s.couples} | ${p.poi.bestTimeOfDay} | ${notes || "-"}`);
    }
    if (leg.pool.experiences.length) {
      lines.push("EXPERIENCES: id | name | minutes | start times | runs on | covers");
      for (const x of leg.pool.experiences) {
        const e = x.experience;
        lines.push(`${x.id} | ${e.name} | ${e.durationMin} | ${e.startTimes.join(",")} | ${e.daysOperating.map((d) => d.slice(0, 3)).join(",")} | ${e.linkedPoiIds.join(",") || "-"}`);
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation, rebalancing
// ---------------------------------------------------------------------------

const LUNCH_MIN = 60;
const SAME_AREA_HOP_MIN = 15;
const NEW_AREA_HOP_CAP_MIN = 45;

type DayCheck = { dayNumber: number; ids: string[]; errors: string[] };

/** Rough minutes a day's items need (same estimate the heuristic uses). */
function dayLoad(ids: string[], leg: AssignLeg, input: AssignInput): number {
  const areas = new Set<string>();
  let total = 0;
  for (const id of ids) {
    const p = leg.pool.pois.find((x) => x.id === id);
    const x = leg.pool.experiences.find((e) => e.id === id);
    if (x) { total += x.experience.durationMin; continue; }
    if (!p) continue;
    const oneWay = taxiMinutes(haversineKm(leg.hotel.area, p.poi), leg.cityId).minutes;
    const travel = isFarDayTrip(p.poi, leg.hotel.area) ? oneWay : areas.has(p.poi.areaId) ? SAME_AREA_HOP_MIN : Math.min(oneWay, NEW_AREA_HOP_CAP_MIN) + SAME_AREA_HOP_MIN;
    areas.add(p.poi.areaId);
    total += Math.round(p.durationMin * (1 + input.levers.bufferPct)) + travel;
  }
  return total;
}

function dayCapacity(f: DayFrame, ids: string[], leg: AssignLeg, input: AssignInput): number {
  const lunch = f.startMin < toMin(input.levers.lunchWindow.end) && f.endMin > toMin(input.levers.lunchWindow.start) ? LUNCH_MIN : 0;
  const hasDayTrip = ids.some((id) => leg.pool.pois.find((p) => p.id === id)?.isDayTrip);
  return f.capacityMin - lunch + (hasDayTrip ? f.startMin - f.earliestStartMin : 0);
}

function checkDays(out: AIAssignOutput, input: AssignInput): { checks: DayCheck[]; missingRequested: string[] } {
  const seen = new Set<string>();
  const checks: DayCheck[] = [];
  for (const leg of input.legs) {
    for (const f of leg.frames) {
      const proposed = out.days.find((d) => d.dayIndex === f.dayNumber);
      const errors: string[] = [];
      const ids: string[] = [];
      for (const id of [...(proposed?.poiIds ?? []), ...(proposed?.experienceIds ?? [])]) {
        const p = leg.pool.pois.find((x) => x.id === id);
        const x = leg.pool.experiences.find((e) => e.id === id);
        if (!p && !x) { errors.push(`${id} is not in the ${leg.cityId} pool`); continue; }
        if (p && f.closedPoiIds.includes(id)) { errors.push(`${id} is closed on ${f.weekday}`); continue; }
        if (x && !x.operatingDates.includes(f.date)) { errors.push(`${id} doesn't run on ${f.weekday}`); continue; }
        if (f.lightOnly && !(p && isLightItem(p, leg.hotel.area))) { errors.push(`${id} is not light but day ${f.dayNumber} is LIGHT`); continue; }
        if (seen.has(id)) { errors.push(`${id} is already on another day`); continue; }
        seen.add(id);
        ids.push(id);
      }
      if (ids.length > f.maxMajorItems) errors.push(`${ids.length} items but max is ${f.maxMajorItems}`);
      const far = ids.filter((id) => { const p = leg.pool.pois.find((x) => x.id === id); return p && isFarDayTrip(p.poi, leg.hotel.area); });
      if (far.length && ids.length > 1) errors.push(`${far[0]} is FULL-DAY and must be alone`);
      checks.push({ dayNumber: f.dayNumber, ids, errors });
    }
  }
  const requested = input.legs.flatMap((l) => l.pool.pois.filter((p) => p.requested).map((p) => p.id));
  return { checks, missingRequested: requested.filter((id) => !seen.has(id)) };
}

/** Move lowest-priority items off over-full days (to a day with room), else drop them. */
function rebalance(checks: DayCheck[], input: AssignInput, notes: string[]) {
  const legOf = (dayNumber: number) => input.legs.find((l) => l.frames.some((f) => f.dayNumber === dayNumber))!;
  const frameOf = (leg: AssignLeg, n: number) => leg.frames.find((f) => f.dayNumber === n)!;
  const score = (leg: AssignLeg, id: string) => {
    const p = leg.pool.pois.find((x) => x.id === id);
    return p ? (p.requested ? 100 : p.score) : 1;
  };
  for (const c of checks) {
    const leg = legOf(c.dayNumber);
    const f = frameOf(leg, c.dayNumber);
    while (c.ids.length && dayLoad(c.ids, leg, input) > dayCapacity(f, c.ids, leg, input)) {
      const victim = [...c.ids].sort((a, b) => score(leg, a) - score(leg, b))[0];
      c.ids = c.ids.filter((id) => id !== victim);
      const target = checks.find((o) => {
        if (o === c || legOf(o.dayNumber) !== leg) return false;
        const of = frameOf(leg, o.dayNumber);
        const p = leg.pool.pois.find((x) => x.id === victim);
        if (p && (of.closedPoiIds.includes(victim) || (of.lightOnly && !isLightItem(p, leg.hotel.area)))) return false;
        const next = [...o.ids, victim];
        return next.length <= of.maxMajorItems && dayLoad(next, leg, input) <= dayCapacity(of, next, leg, input);
      });
      if (target) {
        target.ids.push(victim);
        notes.push(`Rebalanced: moved ${victim} from day ${c.dayNumber} to day ${target.dayNumber} (day ${c.dayNumber} over capacity)`);
      } else {
        notes.push(`Rebalanced: dropped ${victim} from day ${c.dayNumber} (over capacity, no other day had room)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export type AIAssignReport = { calls: LLMMeta[]; notes: string[]; fallbackDays: number[]; fullFallback: boolean };

/**
 * Build an AssignFn backed by Gemini. `report` is filled in as it runs so the
 * caller can show what happened (calls, retries, fallbacks).
 */
export function makeAIAssign(opts: { locked?: Record<number, string[]>; preferences?: string[]; report: AIAssignReport }): AssignFn {
  const { report } = opts;
  const locked = opts.locked ?? {};
  return async (input: AssignInput): Promise<AssignOutput> => {
    const base = buildPrompt(input, locked, opts.preferences ?? []);
    let out: AIAssignOutput;
    try {
      const first = await callLLM({ name: "assignDays", system: ASSIGN_SYSTEM, prompt: base, schema: AIAssignOutput, temperature: 0.3 });
      report.calls.push(first.meta);
      out = first.data;
      const { checks, missingRequested } = checkDays(out, input);
      const problems = [...checks.flatMap((c) => c.errors.map((e) => `day ${c.dayNumber}: ${e}`)), ...missingRequested.map((id) => `REQUESTED ${id} is missing`)];
      if (problems.length) {
        report.notes.push(`AI assignment had ${problems.length} problem(s); retrying once: ${problems.slice(0, 5).join("; ")}`);
        try {
          const second = await callLLM({
            name: "assignDays",
            system: ASSIGN_SYSTEM,
            prompt: `${base}\n\nYOUR PREVIOUS ASSIGNMENT HAD THESE PROBLEMS — fix them:\n${problems.map((p) => `- ${p}`).join("\n")}`,
            schema: AIAssignOutput,
            temperature: 0.2,
          });
          report.calls.push(second.meta);
          out = second.data;
        } catch (e) {
          report.notes.push(`Retry failed (${(e as Error).message.slice(0, 120)}); keeping the first answer`);
        }
      }
    } catch (e) {
      report.fullFallback = true;
      report.notes.push(`AI assignment unavailable (${(e as Error).message.slice(0, 160)}); used the heuristic`);
      return assignDaysHeuristic(input);
    }

    const { checks } = checkDays(out, input);
    const failed = new Set(checks.filter((c) => c.errors.length).map((c) => c.dayNumber));
    for (const c of checks) for (const e of c.errors) report.notes.push(`Day ${c.dayNumber}: ${e}`);
    rebalance(checks.filter((c) => !failed.has(c.dayNumber)), input, report.notes);

    // Failed days: heuristic, working only with items no good AI day already uses.
    let heuristicDays: AssignedDay[] = [];
    if (failed.size) {
      report.fallbackDays = [...failed];
      const used = new Set(checks.filter((c) => !failed.has(c.dayNumber)).flatMap((c) => c.ids));
      const reduced: AssignInput = {
        ...input,
        legs: input.legs.map((l) => ({ ...l, pool: { ...l.pool, pois: l.pool.pois.filter((p) => !used.has(p.id)), experiences: l.pool.experiences.filter((x) => !used.has(x.id)) } })),
      };
      heuristicDays = assignDaysHeuristic(reduced).days;
      report.notes.push(`Heuristic used for day(s) ${[...failed].join(", ")} after the retry still failed`);
    }

    const days: AssignedDay[] = checks.map((c) => {
      if (failed.has(c.dayNumber)) {
        const h = heuristicDays.find((d) => d.dayNumber === c.dayNumber);
        return { ...(h ?? { dayNumber: c.dayNumber, itemIds: [] }), source: "planner" as const };
      }
      const ai = out.days.find((d) => d.dayIndex === c.dayNumber);
      const reasons = Object.fromEntries((ai?.whySelected ?? []).filter((w) => c.ids.includes(w.id)).map((w) => [w.id, w.reasons]));
      return { dayNumber: c.dayNumber, itemIds: c.ids, reasons, theme: ai?.theme, source: "ai" as const };
    });
    return { days, source: "ai", notes: report.notes };
  };
}
