/**
 * Stage 5 — describe each day before anything is placed in it: its window,
 * capacity, energy, closures, crowds and fixed commitments.
 */
import type { City, Constraint, Event, Levers, PresetsFile, StageResult } from "../types";
import { ofType, travellerProfiles } from "./constraints";
import type { CandidatePool, DayFrame, LegAlloc } from "./plannerTypes";
import { fromMin, toMin, weekdayOf } from "./time";
import { startTrace } from "./trace";
import { accessMin, departureMode, GATEWAY_LEAD_MIN, intercitySegments } from "./transfers";

const ARRIVAL_SHARE = 0.5; // arrival day: roughly the second half of the day
const DEPARTURE_SHARE = 0.5; // departure day: roughly the first half
const TRAVEL_DAY_SHARE = 0.6; // a travel day keeps ~60% of normal capacity at most
const CHECK_IN_MIN = 30;
const LONG_TRANSFER_MIN = 240;
/** Assumed onward departure = end of sightseeing + this slack (lunch, return) + access + lead, rounded up to :00/:30. */
const DEPARTURE_SLACK_MIN = 90;
/** Long day trips may start this early instead of dayStart (a soft, rejectable override). */
export const EARLIEST_OVERRIDE_START = "08:30";

export function buildDayFrames(args: {
  leg: LegAlloc;
  levers: Levers;
  events: Event[];
  constraints: Constraint[];
  pool: CandidatePool;
  cities: City[];
  /** For day-scoped pace ("make day 2 more relaxed"): that preset's item limit applies to that day. */
  presets?: PresetsFile;
}): StageResult<DayFrame[]> {
  const { leg, levers, events, constraints, pool, cities } = args;
  const cityOf = (id: string) => cities.find((c) => c.id === id)!;
  const t = startTrace("buildDayFrames", { cityId: leg.cityId, dates: leg.dates });
  const dayStart = toMin(levers.dayStart);
  const dayEnd = toMin(levers.dayEnd);
  const span = dayEnd - dayStart;
  const anchors = ofType(constraints, "date_anchor");
  const dayWindows = ofType(constraints, "day_window").filter((c) => c.scope.startsWith("day:"));
  // Relaxed or elderly groups shouldn't tackle a major site on a day they also travel between cities.
  const lightTravelDays =
    ofType(constraints, "pace").some((c) => c.params.pace === "relaxed") || travellerProfiles(constraints).includes("elderly");

  const frames: DayFrame[] = leg.dates.map((date, k) => {
    const weekday = weekdayOf(date);
    const isArrival = leg.isFirst && k === 0;
    const isTravel = !leg.isFirst && k === 0;
    const isDeparture = leg.isLast && k === leg.dates.length - 1;
    const notes: string[] = [];
    let startMin = dayStart;
    let endMin = dayEnd;
    let energy = 1;
    let transfer: DayFrame["transfer"] = null;

    if (isArrival) {
      startMin = dayEnd - Math.round(span * ARRIVAL_SHARE);
      energy = 0.8;
      notes.push(`Arrival day: sightseeing from ~${fromMin(startMin)}`);
    }
    if (isTravel && leg.inbound) {
      // Leave the hotel at the usual start; the departure time this implies is shown as an assumption.
      const seg = intercitySegments(leg.inbound, dayStart, cityOf(leg.inbound.from), cityOf(leg.inbound.to));
      transfer = { startMin: dayStart, endMin: seg.arriveHotelMin, hop: leg.inbound, segments: seg.segments };
      startMin = seg.arriveHotelMin + CHECK_IN_MIN;
      energy = 0.6;
      notes.push(`Travel day: ${leg.inbound.from} → ${leg.inbound.to} by ${leg.inbound.edge.mode}, assumed departure ${fromMin(seg.depMin)}`);
    }
    if (isDeparture) {
      endMin = Math.min(endMin, dayStart + Math.round(span * DEPARTURE_SHARE));
      energy = Math.min(energy, 0.8);
      notes.push(`Departure day: sightseeing until ~${fromMin(endMin)}`);
    }
    if (k === 1 && leg.inbound && leg.inbound.minutes > LONG_TRANSFER_MIN) {
      energy = Math.min(energy, 0.85);
      notes.push("Lighter day after a long transfer");
    }

    // A day-scoped day_window (e.g. an accepted or rejected early-start chip) sets this day's hours.
    const own = dayWindows.find((c) => c.scope === `day:${leg.dayNumbers[k]}`);
    if (own?.params.start && !isArrival && !isTravel) startMin = toMin(own.params.start);
    if (own?.params.end) endMin = toMin(own.params.end);
    if (own) notes.push(`Day hours set by ${own.id} (${own.params.start ?? ""}–${own.params.end ?? ""})`);
    // Only full/departure days can start earlier, and not if the user already fixed this day's hours.
    const earliestStartMin = isArrival || isTravel || own ? startMin : Math.min(startMin, toMin(EARLIEST_OVERRIDE_START));
    const lightOnly = lightTravelDays && (isArrival || isTravel);
    if (lightOnly) notes.push("Arrival/travel day: light sights near the hotel only");

    let departure: DayFrame["departure"] = null;
    if (isDeparture) {
      const city = cityOf(leg.cityId);
      const mode = departureMode(city);
      const access = accessMin(city, mode);
      const lead = GATEWAY_LEAD_MIN[mode];
      const depMin = Math.ceil((endMin + DEPARTURE_SLACK_MIN + access + lead) / 30) * 30;
      departure = { mode, depMin, leadMin: lead, accessMin: access, cityName: city.name };
      notes.push(`Assumed onward ${mode} ~${fromMin(depMin)}: be at the ${mode === "flight" ? "airport" : "station"} ${lead} min before`);
    }

    // Day-scoped pace: only this day follows the other preset's item limit.
    const dayPace = ofType(constraints, "pace").find((c) => c.scope === `day:${leg.dayNumbers[k]}`);
    const paceMax = dayPace && args.presets ? args.presets.presets[dayPace.params.pace].maxMajorItemsPerDay : undefined;
    if (dayPace) notes.push(`Pace for this day: ${dayPace.params.pace} (${dayPace.id})`);

    let capacityMin = Math.max(0, endMin - startMin);
    if (isTravel) capacityMin = Math.min(capacityMin, Math.round(span * TRAVEL_DAY_SHARE));

    const todaysEvents = events.filter((e) => e.cityId === leg.cityId && date >= e.startDate && date <= e.endDate);
    const closureIds = new Set(todaysEvents.filter((e) => e.impact.kind === "closure").flatMap((e) => e.impact.affectedPoiIds));
    const closedPoiIds = pool.pois
      .filter((p) => !p.openDates.includes(date) || closureIds.has(p.id))
      .map((p) => p.id);
    const crowdedPoiIds = todaysEvents.filter((e) => e.impact.kind === "crowds").flatMap((e) => e.impact.affectedPoiIds);
    for (const e of todaysEvents) notes.push(`Event: ${e.name} (${e.impact.kind}, ${e.impact.level})`);

    const anchoredPoiIds = anchors
      .filter((c) => c.params.date === date && c.params.poiId && pool.pois.some((p) => p.id === c.params.poiId))
      .map((c) => c.params.poiId!);

    return {
      dayNumber: leg.dayNumbers[k],
      date,
      weekday,
      cityId: leg.cityId,
      isArrival,
      isTravel,
      isDeparture,
      startMin,
      endMin,
      earliestStartMin,
      lightOnly,
      capacityMin,
      maxMajorItems: Math.max(1, Math.round((paceMax ?? levers.maxMajorItemsPerDay) * energy)),
      energy,
      transfer,
      departure,
      anchoredPoiIds,
      closedPoiIds,
      crowdedPoiIds,
      events: todaysEvents,
      notes,
    };
  });

  for (const f of frames) {
    t.decide(
      `day ${f.dayNumber} ${f.weekday} ${fromMin(f.startMin)}–${fromMin(f.endMin)}`,
      `capacity ${f.capacityMin}min, energy ${f.energy}, max ${f.maxMajorItems} items`,
      { closed: f.closedPoiIds, notes: f.notes },
    );
  }
  return t.finish(frames, { days: frames.length });
}
