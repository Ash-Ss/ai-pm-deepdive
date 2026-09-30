/**
 * Day assignment: which pool items go on which day.
 *
 * This is the one pipeline step the LLM will take over later, so it sits behind
 * the AssignFn interface. Whatever the assigner returns is passed through
 * sanitizeAssignment, which drops any ID that isn't in that leg's pool, is
 * closed that day, is too heavy for a light travel day, or is duplicated — the
 * AI can choose, never invent.
 *
 * assignDaysHeuristic is the deterministic fallback: must-sees first, grouped
 * by area, respecting closures, item limits and time capacity.
 */
import type { Constraint, Levers, StageResult } from "../types";
import { travellerProfiles } from "./constraints";
import { haversineKm, isFarDayTrip, type LatLng, taxiMinutes } from "./geo";
import type { CandidatePool, DayFrame, HotelBase, PoolPoi } from "./plannerTypes";
import { toMin } from "./time";
import { startTrace } from "./trace";

export type AssignLeg = { cityId: string; hotel: HotelBase; frames: DayFrame[]; pool: CandidatePool };
export type AssignInput = { legs: AssignLeg[]; levers: Levers; constraints: Constraint[] };
export type AssignedDay = { dayNumber: number; itemIds: string[]; reasons?: Record<string, string[]> };
export type AssignOutput = { days: AssignedDay[]; source: "planner" | "ai"; notes?: string[] };
export type AssignFn = (input: AssignInput) => AssignOutput | Promise<AssignOutput>;

const SAME_AREA_HOP_MIN = 15;
const NEW_AREA_HOP_CAP_MIN = 45;
const LUNCH_MIN = 60;
/** "Light" = short and close: what a tired group can manage on an arrival/travel day. */
const LIGHT_MAX_MIN = 75;
const LIGHT_MAX_KM = 5;
/** Sites where a guide adds this much value get their guided tour for elderly groups, if it fits. */
const GUIDED_TOUR_VALUE = 0.7;

export function isLightItem(p: PoolPoi, hotel: LatLng): boolean {
  return p.durationMin <= LIGHT_MAX_MIN && haversineKm(hotel, p.poi) <= LIGHT_MAX_KM;
}

// ---------------------------------------------------------------------------
// Guard for any assigner (heuristic or AI)
// ---------------------------------------------------------------------------

export function sanitizeAssignment(input: AssignInput, output: AssignOutput): StageResult<AssignOutput> {
  const t = startTrace("sanitizeAssignment", { source: output.source, days: output.days.length });
  for (const n of output.notes ?? []) t.decide("assigner note", n);
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
        else if (frame.lightOnly && !(poi && isLightItem(poi, leg.hotel.area))) reason = "arrival/travel day: only light sights near the hotel";
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
  return t.finish({ days, source: output.source, notes: output.notes }, { itemsKept: days.reduce((s, d) => s + d.itemIds.length, 0) });
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

export function assignDaysHeuristic(input: AssignInput): AssignOutput {
  const days: AssignedDay[] = [];
  const notes: string[] = [];
  const elderly = travellerProfiles(input.constraints).includes("elderly");
  for (const leg of input.legs) days.push(...assignLeg(leg, input.levers, elderly, notes));
  return { days, source: "planner", notes: [...new Set(notes)] };
}

type DaySlot = {
  frame: DayFrame;
  ids: string[];
  reasons: Record<string, string[]>;
  areas: Set<string>;
  exclusive: boolean;
  remaining: number;
  /** Extra minutes available if the day starts early for a day trip (used once). */
  extension: number;
};

function assignLeg(leg: AssignLeg, levers: Levers, elderly: boolean, notes: string[]): AssignedDay[] {
  const lunchStart = toMin(levers.lunchWindow.start);
  const lunchEnd = toMin(levers.lunchWindow.end);
  const hotel = leg.hotel.area;
  const days: DaySlot[] = leg.frames.map((f) => ({
    frame: f,
    ids: [],
    reasons: {},
    areas: new Set<string>(),
    exclusive: false,
    // Capacity minus lunch if lunch falls inside the sightseeing window.
    remaining: f.capacityMin - (f.startMin < lunchEnd && f.endMin > lunchStart ? LUNCH_MIN : 0),
    extension: f.startMin - f.earliestStartMin,
  }));

  const place = (d: DaySlot, id: string, cost: number, area: string, why: string[], exclusive: boolean) => {
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
  const isExclusive = (p: PoolPoi) => isFarDayTrip(p.poi, hotel);
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

  /** Place the guided tour linked to `p` instead of `p`, if one exists and fits a free day. */
  const tryGuidedTour = (p: PoolPoi): boolean => {
    for (const x of leg.pool.excludedExperiences.filter((e) => e.linkedPoiIds.includes(p.id))) {
      notes.push(`Guided tour ${x.id} considered but left out: ${x.reason}`);
    }
    const tours = leg.pool.experiences.filter((x) => x.experience.linkedPoiIds.includes(p.id));
    for (const x of tours) {
      const dur = x.experience.durationMin;
      const fits = days.find((d) => {
        if (d.frame.lightOnly || d.exclusive || d.ids.length > 0 || !x.operatingDates.includes(d.frame.date)) return false;
        return x.experience.startTimes.some((st) => toMin(st) >= d.frame.earliestStartMin && toMin(st) + dur <= d.frame.endMin);
      });
      if (!fits) {
        notes.push(`Guided tour "${x.experience.name}" considered for ${p.poi.name} but no free day fits its ${Math.round(dur / 60)}h schedule`);
        continue;
      }
      const covered = x.experience.linkedPoiIds.filter((id) => leg.pool.pois.some((pp) => pp.id === id));
      place(fits, x.id, dur, p.poi.areaId, [`guided tour with transport covers ${covered.join(", ")}`, "a guide adds a lot here"], true);
      for (const id of covered) placed.add(id);
      return true;
    }
    return false;
  };

  for (const p of candidates) {
    if (placed.has(p.id)) continue;
    const kmFromHotel = haversineKm(hotel, p.poi);
    const oneWay = taxiMinutes(kmFromHotel, leg.cityId).minutes;
    const exclusive = isExclusive(p);

    // Day trips nobody asked for must respect the daily transit limit.
    if (p.isDayTrip && !p.requested && 2 * oneWay > levers.maxTransitMinPerDay) {
      notes.push(`Skipped ${p.poi.name}: ~${2 * oneWay} min round trip exceeds the ${levers.maxTransitMinPerDay} min/day transit limit`);
      continue;
    }

    // Elderly + a site that really benefits from a guide → try its guided tour first.
    if (elderly && p.poi.tourValue >= GUIDED_TOUR_VALUE && tryGuidedTour(p)) continue;

    const visit = Math.round(p.durationMin * (1 + levers.bufferPct));
    const options = days
      .filter((d) => !d.frame.closedPoiIds.includes(p.id) && !d.exclusive && d.ids.length < d.frame.maxMajorItems)
      .filter((d) => !exclusive || d.ids.length === 0)
      .filter((d) => !d.frame.lightOnly || isLightItem(p, hotel))
      .map((d) => {
        const sameArea = d.areas.has(p.poi.areaId);
        // Only the outbound drive eats sightseeing time; the drive back can run past dayEnd.
        const travel = exclusive ? oneWay : sameArea ? SAME_AREA_HOP_MIN : Math.min(oneWay, NEW_AREA_HOP_CAP_MIN) + SAME_AREA_HOP_MIN;
        // A day trip may start the day early; anything joining it in the same area benefits too.
        const room = d.remaining + (p.isDayTrip || sameArea ? d.extension : 0);
        return { d, sameArea, cost: visit + travel, room };
      })
      .filter((o) => o.cost <= o.room);

    if (options.length === 0) continue; // pipeline warns if a requested item ends up missing
    // Prefer grouping with the same area; otherwise the roomiest day (earliest on ties).
    // Light items go to light travel days first (only they can use those days), then group by area,
    // then the roomiest day (earliest on ties).
    const light = isLightItem(p, hotel);
    options.sort((a, b) =>
      Number(light && b.d.frame.lightOnly) - Number(light && a.d.frame.lightOnly) ||
      Number(b.sameArea) - Number(a.sameArea) || b.room - a.room || a.d.frame.dayNumber - b.d.frame.dayNumber);
    const { d, sameArea, cost } = options[0];
    if (p.isDayTrip && d.extension > 0) {
      d.remaining += d.extension; // this day will start early; bank the extra time once
      d.extension = 0;
    }

    const why: string[] = [];
    if (p.requested) why.push("you asked for this");
    if (p.poi.tier === "must_see") why.push("must-see in " + leg.cityId);
    if (p.scoreParts.some((s) => s.label === "interest match")) why.push("matches your interests");
    if (sameArea) why.push(`same area as other stops (${p.poi.areaId})`);
    if (exclusive) why.push(`full-day trip (~${Math.round((oneWay / 60) * 10) / 10}h drive each way)`);
    if (d.frame.lightOnly) why.push("light, near the hotel (travel day)");
    place(d, p.id, cost, p.poi.areaId, why, exclusive);
    placed.add(p.id);
  }

  return days.map((d) => ({ dayNumber: d.frame.dayNumber, itemIds: d.ids, reasons: d.reasons }));
}
