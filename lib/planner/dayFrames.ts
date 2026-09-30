/**
 * Stage 5 — describe each day before anything is placed in it: its window,
 * capacity, energy, closures, crowds and fixed commitments.
 */
import type { Constraint, Event, Levers, StageResult } from "../types";
import { ofType } from "./constraints";
import type { CandidatePool, DayFrame, LegAlloc } from "./plannerTypes";
import { fromMin, toMin, weekdayOf } from "./time";
import { startTrace } from "./trace";

const ARRIVAL_SHARE = 0.5; // arrival day: roughly the second half of the day
const DEPARTURE_SHARE = 0.5; // departure day: roughly the first half
const TRAVEL_DAY_SHARE = 0.6; // a travel day keeps ~60% of normal capacity at most
const CHECK_IN_MIN = 30;
const LONG_TRANSFER_MIN = 240;

export function buildDayFrames(args: {
  leg: LegAlloc;
  levers: Levers;
  events: Event[];
  constraints: Constraint[];
  pool: CandidatePool;
}): StageResult<DayFrame[]> {
  const { leg, levers, events, constraints, pool } = args;
  const t = startTrace("buildDayFrames", { cityId: leg.cityId, dates: leg.dates });
  const dayStart = toMin(levers.dayStart);
  const dayEnd = toMin(levers.dayEnd);
  const span = dayEnd - dayStart;
  const anchors = ofType(constraints, "date_anchor");

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
      const end = dayStart + leg.inbound.minutes;
      transfer = { startMin: dayStart, endMin: end, hop: leg.inbound };
      startMin = end + CHECK_IN_MIN;
      energy = 0.6;
      notes.push(`Travel day: ${leg.inbound.from} → ${leg.inbound.to} by ${leg.inbound.edge.mode} (${leg.inbound.minutes}min)`);
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
      capacityMin,
      maxMajorItems: Math.max(1, Math.round(levers.maxMajorItemsPerDay * energy)),
      energy,
      transfer,
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
