/**
 * Day assignment: which pool items go on which day.
 *
 * This is the one pipeline step the LLM will take over later, so it sits behind
 * the AssignFn interface. Whatever the assigner returns is passed through
 * sanitizeAssignment, which drops any ID that isn't in that leg's pool, is
 * closed that day, or is duplicated — the AI can choose, never invent.
 *
 * assignDaysHeuristic is the deterministic fallback: must-sees first, grouped
 * by area, respecting closures, item limits and time capacity.
 */
import type { Constraint, Levers, StageResult } from "../types";
import { haversineKm, taxiMinutes } from "./geo";
import type { CandidatePool, DayFrame, HotelBase, PoolPoi } from "./plannerTypes";
import { toMin } from "./time";
import { startTrace } from "./trace";

export type AssignLeg = { cityId: string; hotel: HotelBase; frames: DayFrame[]; pool: CandidatePool };
export type AssignInput = { legs: AssignLeg[]; levers: Levers; constraints: Constraint[] };
export type AssignedDay = { dayNumber: number; itemIds: string[]; reasons?: Record<string, string[]> };
export type AssignOutput = { days: AssignedDay[]; source: "planner" | "ai" };
export type AssignFn = (input: AssignInput) => AssignOutput | Promise<AssignOutput>;

/** Beyond this distance from the hotel a day trip takes the whole day. */
const EXCLUSIVE_DAY_TRIP_KM = 60;
const SAME_AREA_HOP_MIN = 15;
const NEW_AREA_HOP_CAP_MIN = 45;
const LUNCH_MIN = 60;

// ---------------------------------------------------------------------------
// Guard for any assigner (heuristic or AI)
// ---------------------------------------------------------------------------

export function sanitizeAssignment(input: AssignInput, output: AssignOutput): StageResult<AssignOutput> {
  const t = startTrace("sanitizeAssignment", { source: output.source, days: output.days.length });
  const seen = new Set<string>();
  const days: AssignedDay[] = [];

  for (const leg of input.legs) {
    for (const frame of leg.frames) {
      const proposed = output.days.find((d) => d.dayNumber === frame.dayNumber);
      const kept: string[] = [];
      for (const id of proposed?.itemIds ?? []) {
        const poi = leg.pool.pois.find((p) => p.id === id);
        const exp = leg.pool.experiences.find((x) => x.id === id);
        let reason: string | null = null;
        if (!poi && !exp) reason = `not in ${leg.cityId} candidate pool`;
        else if (poi && frame.closedPoiIds.includes(id)) reason = `closed on ${frame.weekday}`;
        else if (exp && !exp.operatingDates.includes(frame.date)) reason = `doesn't run on ${frame.weekday}`;
        else if (seen.has(id)) reason = "already used on another day";
        if (reason) {
          t.decide(`dropped ${id} from day ${frame.dayNumber}`, reason);
          continue;
        }
        seen.add(id);
        kept.push(id);
      }
      days.push({ dayNumber: frame.dayNumber, itemIds: kept, reasons: proposed?.reasons });
    }
  }
  const unknownDays = output.days.filter((d) => !days.some((k) => k.dayNumber === d.dayNumber));
  for (const d of unknownDays) t.decide(`ignored day ${d.dayNumber}`, "no such day in the trip");
  return t.finish({ days, source: output.source }, { itemsKept: days.reduce((s, d) => s + d.itemIds.length, 0) });
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

export function assignDaysHeuristic(input: AssignInput): AssignOutput {
  const out: AssignedDay[] = [];
  for (const leg of input.legs) out.push(...assignLeg(leg, input.levers));
  return { days: out, source: "planner" };
}

function assignLeg(leg: AssignLeg, levers: Levers): AssignedDay[] {
  const lunchStart = toMin(levers.lunchWindow.start);
  const lunchEnd = toMin(levers.lunchWindow.end);
  const days = leg.frames.map((f) => ({
    frame: f,
    ids: [] as string[],
    reasons: {} as Record<string, string[]>,
    areas: new Set<string>(),
    exclusive: false,
    // Capacity minus lunch if lunch falls inside the sightseeing window.
    remaining: f.capacityMin - (f.startMin < lunchEnd && f.endMin > lunchStart ? LUNCH_MIN : 0),
  }));

  const place = (d: (typeof days)[number], id: string, cost: number, area: string, why: string[], exclusive: boolean) => {
    d.ids.push(id);
    d.reasons[id] = why;
    d.areas.add(area);
    d.remaining -= cost;
    d.exclusive ||= exclusive;
  };

  // Anchored items go on their date, no questions asked.
  const placed = new Set<string>();
  for (const d of days) {
    for (const id of d.frame.anchoredPoiIds) {
      const p = leg.pool.pois.find((x) => x.id === id)!;
      place(d, id, p.durationMin, p.poi.areaId, ["date anchor requested by user"], false);
      placed.add(id);
    }
  }

  const tierRank = { must_see: 0, worth_it: 1, niche: 2 };
  const isExclusive = (p: PoolPoi) => p.isDayTrip && haversineKm(leg.hotel.area, p.poi) > EXCLUSIVE_DAY_TRIP_KM;
  const priority = (a: PoolPoi, b: PoolPoi) =>
    Number(b.requested) - Number(a.requested) ||
    // Whole-day trips are the hardest to fit, so they pick their day first.
    Number(isExclusive(b)) - Number(isExclusive(a)) ||
    tierRank[a.poi.tier] - tierRank[b.poi.tier] ||
    b.score - a.score;

  // Walk the pool cluster by cluster (one cluster per area, led by its best item) so
  // neighbours like Ellora and Grishneshwar land on the same day.
  const byArea = new Map<string, PoolPoi[]>();
  for (const p of [...leg.pool.pois].sort(priority)) byArea.set(p.poi.areaId, [...(byArea.get(p.poi.areaId) ?? []), p]);
  const candidates = [...byArea.values()].sort((a, b) => priority(a[0], b[0])).flat();

  for (const p of candidates) {
    if (placed.has(p.id)) continue;
    const kmFromHotel = haversineKm(leg.hotel.area, p.poi);
    const oneWay = taxiMinutes(kmFromHotel, leg.cityId).minutes;
    const exclusive = isExclusive(p);
    const visit = Math.round(p.durationMin * (1 + levers.bufferPct));

    const options = days
      .filter((d) => !d.frame.closedPoiIds.includes(p.id) && !d.exclusive && d.ids.length < d.frame.maxMajorItems)
      .filter((d) => !exclusive || d.ids.length === 0)
      .map((d) => {
        const sameArea = d.areas.has(p.poi.areaId);
        // Only the outbound drive eats sightseeing time; the drive back can run past dayEnd.
        const travel = exclusive ? oneWay : sameArea ? SAME_AREA_HOP_MIN : Math.min(oneWay, NEW_AREA_HOP_CAP_MIN) + SAME_AREA_HOP_MIN;
        return { d, sameArea, cost: visit + travel };
      })
      .filter((o) => o.cost <= o.d.remaining);

    if (options.length === 0) continue; // pipeline warns if a requested item ends up missing
    // Prefer grouping with the same area; otherwise the roomiest day (earliest on ties).
    options.sort((a, b) => Number(b.sameArea) - Number(a.sameArea) || b.d.remaining - a.d.remaining || a.d.frame.dayNumber - b.d.frame.dayNumber);
    const { d, sameArea, cost } = options[0];

    const why: string[] = [];
    if (p.requested) why.push("you asked for this");
    if (p.poi.tier === "must_see") why.push("must-see in " + leg.cityId);
    const interest = p.scoreParts.find((s) => s.label === "interest match");
    if (interest) why.push("matches your interests");
    if (sameArea) why.push(`same area as other stops (${p.poi.areaId})`);
    if (exclusive) why.push(`full-day trip (~${Math.round(oneWay / 60 * 10) / 10}h drive each way)`);
    if (p.variant) why.push(`lighter version: ${p.variant.name}`);
    place(d, p.id, cost, p.poi.areaId, why, exclusive);
    placed.add(p.id);
  }

  return days.map((d) => ({ dayNumber: d.frame.dayNumber, itemIds: d.ids, reasons: d.reasons }));
}
