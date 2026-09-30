/**
 * Types shared between planner stages that aren't part of the public data model
 * in lib/types.ts (they describe intermediate pipeline state).
 */
import type { Accessibility, Area, Event, Experience, Item, Poi, PoiVariant, Restaurant, Tier, TripInput } from "../types";
import type { Hop } from "./routeOrder";

export type PlannerContext = {
  budgetTier: Tier;
  pax: number;
  travellers: TripInput["travellers"];
  /** POIs the user explicitly asked for (poi_include + named day trips). */
  requestedPoiIds: Set<string>;
};

export type ScorePart = { label: string; value: number };

export type PoolPoi = {
  id: string;
  poi: Poi;
  /** Lighter version chosen because the full POI failed a mobility filter (or by repair). */
  variant: PoiVariant | null;
  /** Typical minutes × durationMultiplier, for whichever version is used. */
  durationMin: number;
  accessibility: Accessibility;
  score: number;
  scoreParts: ScorePart[];
  openDates: string[];
  isDayTrip: boolean;
  requested: boolean;
};

export type PoolExperience = { id: string; experience: Experience; score: number; operatingDates: string[] };

export type FunnelStep = { step: string; remaining: number; removed: string[] };

export type ExcludedMustSee = { id: string; name: string; reason: string; variantNote: string | null };

export type CandidatePool = {
  cityId: string;
  pois: PoolPoi[];
  restaurants: Restaurant[];
  experiences: PoolExperience[];
  funnel: FunnelStep[];
  excludedMustSees: ExcludedMustSee[];
  /** Experiences left out, with why (shown in traces; e.g. too much walking). */
  excludedExperiences: { id: string; reason: string; linkedPoiIds: string[] }[];
};

export type LegAlloc = {
  cityId: string;
  nights: number;
  /** Dates of the days spent in this leg (the first is the arrival/travel day). */
  dates: string[];
  dayNumbers: number[];
  /** Transfer that brings the traveller into this leg (null for the first leg unless arriving from elsewhere). */
  inbound: Hop | null;
  isFirst: boolean;
  isLast: boolean;
};

export type DayFrame = {
  dayNumber: number;
  date: string;
  weekday: string;
  cityId: string;
  isArrival: boolean;
  isTravel: boolean;
  isDeparture: boolean;
  /** Sightseeing window, minutes since midnight. */
  startMin: number;
  endMin: number;
  /** How early the scheduler may start instead, for long day-trip days (= startMin if not allowed). */
  earliestStartMin: number;
  /** Arrival/travel day for a relaxed or elderly group: only light items near the hotel. */
  lightOnly: boolean;
  capacityMin: number;
  maxMajorItems: number;
  /** 1 = full energy; lower after travel. */
  energy: number;
  /** Intercity transfer that occupies the start of the day. */
  transfer: { startMin: number; endMin: number; hop: Hop } | null;
  /** POIs that must be on this day (date_anchor). */
  anchoredPoiIds: string[];
  /** Pool POIs closed on this date (weekly off or closure event). */
  closedPoiIds: string[];
  /** Pool POIs affected by crowd events today. */
  crowdedPoiIds: string[];
  events: Event[];
  notes: string[];
};

export type HotelBase = { area: Area; cityId: string };

export type ScheduledDay = {
  frame: DayFrame;
  items: Item[];
  /** Assigned items that could not be fitted into the day. */
  dropped: { refId: string; reason: string }[];
  penalties: Record<string, number>;
  totals: { walkKm: number; transitMin: number; costINR: number };
  /** Transit allowance above levers for explicitly requested far day trips. */
  dayTripTransitAllowanceMin: number;
  /** Set when the day was started earlier than dayStart to make a day trip work. */
  startOverride: { fromMin: number; toMin: number } | null;
};
